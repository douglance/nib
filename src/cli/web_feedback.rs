use super::{
    commands::ensure_feedback_nib, FeedbackArgs, FeedbackUi, RequestCreateArgs, RequestReviewArgs,
    RequestWaitArgs,
};
use crate::core::{ImageSource, NibImage};
use crate::storage::{export, nib_file::NibFile};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_PORTAL_URL: &str = "https://app.nibtool.com";

#[derive(Debug)]
pub struct WebFeedbackError {
    message: String,
    fallback_allowed: bool,
}

impl WebFeedbackError {
    pub fn allows_local_fallback(&self) -> bool {
        self.fallback_allowed
    }

    fn before_publish(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            fallback_allowed: true,
        }
    }

    fn after_publish(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            fallback_allowed: false,
        }
    }
}

impl fmt::Display for WebFeedbackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct PublishedFeedback {
    pub request_id: String,
    pub url: String,
    pub file: std::path::PathBuf,
    pub status: &'static str,
}

#[derive(Debug)]
pub(crate) enum WaitError {
    TimedOut {
        request_id: String,
        url: String,
        timeout_seconds: u64,
    },
    Terminal {
        request_id: String,
        url: String,
        status: String,
    },
    Fatal(String),
}

impl fmt::Display for WaitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimedOut {
                request_id,
                url,
                timeout_seconds,
            } => write!(
                formatter,
                "request {request_id} did not receive a response within {timeout_seconds}s; it remains open at {url}. Resume with: nib request wait {request_id}"
            ),
            Self::Terminal {
                request_id,
                url,
                status,
            } => write!(
                formatter,
                "request {request_id} reached terminal status '{status}' without a response ({url})"
            ),
            Self::Fatal(message) => formatter.write_str(message),
        }
    }
}

pub async fn run(args: &FeedbackArgs) -> Result<(), WebFeedbackError> {
    let published = create_review_request(
        &args.file,
        args.message.as_deref(),
        args.annotations.as_deref(),
    )?;
    finish_published(args, published).await
}

async fn finish_published(
    args: &FeedbackArgs,
    published: PublishedFeedback,
) -> Result<(), WebFeedbackError> {
    print_wait_handle(&published);
    let value = finish_published_value(args, published).await?;
    println!("{}", serde_json::to_string(&value).unwrap_or_default());
    Ok(())
}

async fn finish_published_value(
    args: &FeedbackArgs,
    published: PublishedFeedback,
) -> Result<Value, WebFeedbackError> {
    if args.detach {
        return serde_json::to_value(published)
            .map_err(|error| WebFeedbackError::after_publish(error.to_string()));
    }

    let response = wait_for_request(&published.request_id, args.timeout)
        .await
        .map_err(|error| WebFeedbackError::after_publish(error.to_string()))?;
    let visual = visual_response(&response).map_err(WebFeedbackError::after_publish)?;
    if published
        .file
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nib"))
    {
        merge_annotations(&published.file, &visual.annotations)
            .map_err(WebFeedbackError::after_publish)?;
    }
    serde_json::to_value(visual).map_err(|error| WebFeedbackError::after_publish(error.to_string()))
}

pub(crate) fn create_review_request(
    file: &Path,
    message: Option<&str>,
    annotations: Option<&str>,
) -> Result<PublishedFeedback, WebFeedbackError> {
    if file
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
    {
        if annotations.is_some() {
            return Err(WebFeedbackError::before_publish(
                "video prompt annotations must be added through the paused-frame reviewer",
            ));
        }
        create_video_review_request(file, message)
    } else {
        create_feedback_request(file, message, annotations)
    }
}

pub fn run_request_create(args: &RequestCreateArgs) -> crate::core::Result<()> {
    let published = create_review_request(
        &args.file,
        args.question.as_deref(),
        args.annotations.as_deref(),
    )
    .map_err(|error| crate::core::NibError::Other(error.to_string()))?;
    println!(
        "{}",
        serde_json::to_string(&published)
            .map_err(|error| crate::core::NibError::Other(error.to_string()))?
    );
    Ok(())
}

pub async fn run_request_wait(args: &RequestWaitArgs) -> crate::core::Result<()> {
    let response = wait_for_request(&args.request_id, args.timeout)
        .await
        .map_err(|error| crate::core::NibError::Other(error.to_string()))?;
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| crate::core::NibError::Other(error.to_string()))?
    );
    Ok(())
}

pub async fn run_request_review(args: &RequestReviewArgs) -> crate::core::Result<()> {
    let response = review_request_value(args).await?;
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| crate::core::NibError::Other(error.to_string()))?
    );
    Ok(())
}

pub(crate) async fn review_request_value(args: &RequestReviewArgs) -> crate::core::Result<Value> {
    let base_url = args
        .portal
        .clone()
        .unwrap_or_else(portal_url)
        .trim_end_matches('/')
        .to_string();
    let request_id = args.request_id.clone();
    let base_url_for_download = base_url.clone();
    let downloaded = tokio::task::spawn_blocking(move || {
        download_review_request(&base_url_for_download, &request_id)
    })
    .await
    .map_err(|error| crate::core::NibError::Other(format!("Request download failed: {error}")))?
    .map_err(crate::core::NibError::Other)?;

    let feedback = FeedbackArgs {
        file: downloaded.file.clone(),
        message: Some(downloaded.prompt.clone()),
        annotations: None,
        timeout: 0,
        ui: FeedbackUi::Native,
        detach: false,
    };
    let response = super::commands::run_native_feedback_value(&feedback).await?;
    let submit_id = args.request_id.clone();
    let submit_url = base_url.clone();
    let submitted = response.clone();
    tokio::task::spawn_blocking(move || {
        submit_review_response(&submit_url, &submit_id, &submitted)
    })
    .await
    .map_err(|error| crate::core::NibError::Other(format!("Response submit failed: {error}")))?
    .map_err(crate::core::NibError::Other)?;

    if let Err(error) = std::fs::remove_dir_all(&downloaded.cache_dir) {
        tracing::warn!(
            "Failed to remove request cache {}: {error}",
            downloaded.cache_dir.display()
        );
    }
    Ok(response)
}

struct DownloadedReview {
    file: std::path::PathBuf,
    cache_dir: std::path::PathBuf,
    prompt: String,
}

fn download_review_request(base_url: &str, request_id: &str) -> Result<DownloadedReview, String> {
    let agent = portal_agent();
    let request = get_request(&agent, base_url, request_id).map_err(|error| match error {
        ReadError::Retryable(message) | ReadError::Fatal(message) => message,
    })?;
    if !request.responses.is_empty()
        || matches!(
            request.status.as_str(),
            "answered" | "acted" | "resolved" | "expired"
        )
    {
        return Err(format!(
            "Request {request_id} is already {}",
            request.status
        ));
    }
    let attachment = primary_review_attachment(&request)
        .ok_or_else(|| format!("Request {request_id} has no reviewable attachment"))?;
    let cache_dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("com.douglance.nib")
        .join("reviews")
        .join(request_id);
    std::fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Failed to create {}: {error}", cache_dir.display()))?;
    let file_name = safe_cache_name(&attachment.name, &attachment.content_type);
    let file = cache_dir.join(file_name);
    let attachment_url =
        if attachment.url.starts_with("http://") || attachment.url.starts_with("https://") {
            attachment.url.clone()
        } else {
            format!("{base_url}{}", attachment.url)
        };
    let response = authorize(agent.get(&attachment_url))
        .call()
        .map_err(http_error)?;
    let mut reader = response.into_reader();
    let mut output = std::fs::File::create(&file)
        .map_err(|error| format!("Failed to create {}: {error}", file.display()))?;
    std::io::copy(&mut reader, &mut output)
        .map_err(|error| format!("Failed to download request media: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("Failed to finalize request media: {error}"))?;

    Ok(DownloadedReview {
        file,
        cache_dir,
        prompt: if request.prompt.trim().is_empty() {
            request.title
        } else {
            request.prompt
        },
    })
}

fn primary_review_attachment(request: &PortalRequest) -> Option<&PortalAttachment> {
    let primary_id = request
        .metadata
        .pointer("/subject/primary/attachmentId")
        .and_then(Value::as_str);
    primary_id
        .and_then(|id| {
            request
                .attachments
                .iter()
                .find(|attachment| attachment.id == id)
        })
        .or_else(|| {
            request.attachments.iter().find(|attachment| {
                attachment
                    .metadata
                    .get("role")
                    .and_then(Value::as_str)
                    .is_some_and(|role| role == "primary")
            })
        })
        .or_else(|| {
            request
                .attachments
                .iter()
                .find(|attachment| attachment.content_type.starts_with("image/"))
        })
}

fn safe_cache_name(name: &str, content_type: &str) -> String {
    let name = std::path::Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            if content_type == "video/mp4" {
                "review.mp4"
            } else {
                "review.png"
            }
        });
    name.to_string()
}

fn submit_review_response(
    base_url: &str,
    request_id: &str,
    response: &Value,
) -> Result<(), String> {
    let agent = portal_agent();
    let _: PortalRequest = send_json(
        authorize(agent.post(&format!("{base_url}/api/requests/{request_id}/respond"))),
        response,
    )?;
    Ok(())
}

pub(crate) fn create_feedback_request(
    file: &Path,
    message: Option<&str>,
    annotations: Option<&str>,
) -> Result<PublishedFeedback, WebFeedbackError> {
    let nib_path = ensure_feedback_nib(file)
        .map_err(|error| WebFeedbackError::after_publish(error.to_string()))?;
    let base_url = portal_url();
    let agent = portal_agent();
    let request = create_request(&agent, &base_url, message, &nib_path)
        .map_err(WebFeedbackError::before_publish)?;
    apply_prompt_annotations(&nib_path, annotations).map_err(WebFeedbackError::after_publish)?;
    let preview = render_preview(&nib_path).map_err(WebFeedbackError::after_publish)?;
    let canonical = std::fs::read(&nib_path).map_err(|error| {
        WebFeedbackError::after_publish(format!("Failed to read {}: {error}", nib_path.display()))
    })?;
    upload_attachment(
        &agent,
        &base_url,
        &request.id,
        "review.png",
        "image/png",
        "preview",
        &preview,
    )
    .and_then(|_| {
        upload_attachment(
            &agent,
            &base_url,
            &request.id,
            nib_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("review.nib"),
            "application/x-nib",
            "canonical",
            &canonical,
        )
    })
    .and_then(|_| publish_request(&agent, &base_url, &request.id))
    .map_err(WebFeedbackError::before_publish)?;

    Ok(PublishedFeedback {
        url: request_url(&base_url, &request.id),
        request_id: request.id,
        file: nib_path,
        status: "open",
    })
}

fn create_video_review_request(
    file: &Path,
    message: Option<&str>,
) -> Result<PublishedFeedback, WebFeedbackError> {
    let media = crate::media::inspect_media(file)
        .map_err(|error| WebFeedbackError::before_publish(error.to_string()))?;
    let base_url = portal_url();
    let agent = portal_agent();
    let file_name = file
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("review.mp4");
    let title = file
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Video review");
    let request: PortalRequest = send_json(
        authorize(agent.post(&format!("{base_url}/api/requests"))),
        &json!({
            "kind": "visual-review",
            "title": title,
            "prompt": message.unwrap_or("Review this video"),
            "source": request_source(),
            "metadata": {"contract":"nib.review/v2","fileName":file_name},
            "notify": false
        }),
    )
    .map_err(WebFeedbackError::before_publish)?;
    let video = upload_file(
        &agent,
        &base_url,
        &request.id,
        file_name,
        "video/mp4",
        "primary",
        file,
    )
    .map_err(WebFeedbackError::before_publish)?;

    let poster_path = crate::media::poster_frame(file, None).ok();
    let poster = poster_path.as_deref().and_then(|poster| {
        upload_file(
            &agent,
            &base_url,
            &request.id,
            poster
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("poster.png"),
            "image/png",
            "poster",
            poster,
        )
        .ok()
    });
    let subject = json!({
        "contract": "nib.review/v2",
        "primary": {
            "attachmentId": video.id,
            "kind": "video",
            "contentType": "video/mp4",
            "width": media.width,
            "height": media.height,
            "durationMs": media.duration_ms,
            "frameRate": media.frame_rate,
            "hasAudio": media.has_audio,
            "posterAttachmentId": poster.as_ref().map(|attachment| attachment.id.as_str()),
            "sha256": media.sha256
        }
    });
    let _: PortalRequest = send_json(
        authorize(agent.patch(&format!("{base_url}/api/requests/{}", request.id))),
        &json!({"metadata":{"subject":subject}}),
    )
    .map_err(WebFeedbackError::before_publish)?;
    publish_request(&agent, &base_url, &request.id).map_err(WebFeedbackError::before_publish)?;

    Ok(PublishedFeedback {
        url: request_url(&base_url, &request.id),
        request_id: request.id,
        file: file.to_path_buf(),
        status: "open",
    })
}

fn print_wait_handle(request: &PublishedFeedback) {
    let _ = writeln!(
        std::io::stderr(),
        "{}",
        json!({
            "event": "request_published",
            "request": request.request_id,
            "url": request.url,
            "resume": format!("nib request wait {}", request.request_id)
        })
    );
    let _ = std::io::stderr().flush();
}

fn portal_url() -> String {
    std::env::var("NIB_PORTAL_URL")
        .unwrap_or_else(|_| DEFAULT_PORTAL_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn portal_agent() -> ureq::Agent {
    let connect_timeout = std::env::var("NIB_PORTAL_CONNECT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1500);
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(connect_timeout))
        .timeout_read(Duration::from_secs(10))
        .timeout_write(Duration::from_secs(10))
        .build()
}

fn authorize(request: ureq::Request) -> ureq::Request {
    match portal_auth_token() {
        Some(token) => request.set("authorization", &format!("Bearer {token}")),
        None => request,
    }
}

fn portal_auth_token() -> Option<String> {
    super::auth::resolved_access_token(&portal_url()).ok()
}

fn create_request(
    agent: &ureq::Agent,
    base_url: &str,
    message: Option<&str>,
    nib_path: &Path,
) -> Result<PortalRequest, String> {
    let file_name = nib_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Visual review");
    let title = nib_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Visual review");
    let prompt = message.unwrap_or("Review this image");
    let body = json!({
        "kind": "visual-review",
        "title": title,
        "prompt": prompt,
        "source": request_source(),
        "metadata": {"contract":"nib.visual-review/v1","fileName":file_name},
        "notify": false
    });
    send_json(
        authorize(agent.post(&format!("{base_url}/api/requests"))),
        &body,
    )
}

#[allow(clippy::too_many_arguments)]
fn upload_attachment(
    agent: &ureq::Agent,
    base_url: &str,
    request_id: &str,
    name: &str,
    content_type: &str,
    role: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let body = json!({
        "name": name,
        "contentType": content_type,
        "contentBase64": BASE64.encode(bytes),
        "metadata": {"role":role}
    });
    let _: Value = send_json(
        authorize(agent.post(&format!("{base_url}/api/requests/{request_id}/attachments"))),
        &body,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upload_file(
    agent: &ureq::Agent,
    base_url: &str,
    request_id: &str,
    name: &str,
    content_type: &str,
    role: &str,
    file: &Path,
) -> Result<PortalAttachment, String> {
    let reader = std::fs::File::open(file)
        .map_err(|error| format!("Failed to open {}: {error}", file.display()))?;
    let length = reader
        .metadata()
        .map_err(|error| format!("Failed to inspect {}: {error}", file.display()))?
        .len();
    authorize(agent.post(&format!("{base_url}/api/requests/{request_id}/attachments")))
        .set("content-type", content_type)
        .set("content-length", &length.to_string())
        .set("x-nib-filename", name)
        .set("x-nib-metadata", &json!({"role":role}).to_string())
        .send(reader)
        .map_err(http_error)?
        .into_json()
        .map_err(|error| format!("Invalid portal attachment response: {error}"))
}

fn publish_request(agent: &ureq::Agent, base_url: &str, request_id: &str) -> Result<(), String> {
    authorize(agent.post(&format!("{base_url}/api/requests/{request_id}/publish")))
        .call()
        .map(|_| ())
        .map_err(http_error)
}

pub(crate) async fn wait_for_request(
    request_id: &str,
    timeout_seconds: u64,
) -> Result<Value, WaitError> {
    let agent = portal_agent();
    let base_url = portal_url();
    wait_for_request_with(agent, base_url, request_id, timeout_seconds).await
}

pub(crate) async fn get_request_value(request_id: &str) -> crate::core::Result<Value> {
    let agent = portal_agent();
    let base_url = portal_url();
    get_v1_request_value_with(agent, base_url, request_id).await
}

async fn get_v1_request_value_with(
    agent: ureq::Agent,
    base_url: String,
    request_id: &str,
) -> crate::core::Result<Value> {
    let request_id = request_id.to_string();
    tokio::task::spawn_blocking(move || get_v1_request_json(&agent, &base_url, &request_id))
        .await
        .map_err(|error| crate::core::NibError::Other(format!("Portal read task failed: {error}")))?
        .map_err(crate::core::NibError::Other)
}

pub(crate) async fn create_v1_request_value(file: &Path) -> crate::core::Result<Value> {
    let value: Value = serde_json::from_slice(&std::fs::read(file)?)
        .map_err(|error| crate::core::NibError::Other(error.to_string()))?;
    let request = nib_protocol::NibRequest::from_value(value).map_err(|error| {
        crate::core::NibError::Other(format!(
            "Invalid request document {}: {error}",
            file.display()
        ))
    })?;
    let body = serde_json::to_value(request)
        .map_err(|error| crate::core::NibError::Other(error.to_string()))?;
    let agent = portal_agent();
    let base_url = portal_url();
    post_v1_request_value_with(agent, base_url, body).await
}

async fn post_v1_request_value_with(
    agent: ureq::Agent,
    base_url: String,
    body: Value,
) -> crate::core::Result<Value> {
    tokio::task::spawn_blocking(move || {
        send_json_value(
            idempotent(authorize(agent.post(&format!("{base_url}/v1/requests")))),
            &body,
        )
    })
    .await
    .map_err(|error| crate::core::NibError::Other(format!("Portal create task failed: {error}")))?
    .map_err(crate::core::NibError::Other)
}

pub(crate) async fn revise_request_value(
    request_id: &str,
    metadata: Option<Value>,
    status: Option<&str>,
) -> crate::core::Result<Value> {
    let mut body = serde_json::Map::new();
    if let Some(metadata) = metadata {
        body.insert("metadata".to_string(), metadata);
    }
    if let Some(status) = status {
        body.insert("status".to_string(), Value::String(status.to_string()));
    }
    if body.is_empty() {
        return Err(crate::core::NibError::Other(
            "request revise needs --metadata or --status".into(),
        ));
    }
    revise_v1_request_value(request_id, Value::Object(body)).await
}

pub(crate) async fn cancel_request_value(request_id: &str) -> crate::core::Result<Value> {
    revise_v1_request_value(request_id, cancel_revision_body()).await
}

async fn revise_v1_request_value(request_id: &str, body: Value) -> crate::core::Result<Value> {
    let agent = portal_agent();
    let base_url = portal_url();
    revise_v1_request_value_with(agent, base_url, request_id, body).await
}

async fn revise_v1_request_value_with(
    agent: ureq::Agent,
    base_url: String,
    request_id: &str,
    body: Value,
) -> crate::core::Result<Value> {
    let request_id = request_id.to_string();
    tokio::task::spawn_blocking(move || {
        send_json_value(
            idempotent(authorize(
                agent.post(&format!("{base_url}/v1/requests/{request_id}/revisions")),
            )),
            &body,
        )
    })
    .await
    .map_err(|error| crate::core::NibError::Other(format!("Portal revise task failed: {error}")))?
    .map_err(crate::core::NibError::Other)
}

pub(crate) async fn submit_request_decision(
    request_id: &str,
    decision: &str,
    comment: Option<&str>,
) -> crate::core::Result<Value> {
    let body = decision_payload(decision, comment);
    let agent = portal_agent();
    let base_url = portal_url();
    create_v1_decision_with(agent, base_url, request_id, body).await
}

fn cancel_revision_body() -> Value {
    json!({"status":"cancelled"})
}

fn decision_payload(decision: &str, comment: Option<&str>) -> Value {
    let mut body = json!({ "outcome": decision, "terminal": true });
    if let Some(comment) = comment {
        body["comment"] = Value::String(comment.to_string());
    }
    body
}

async fn create_v1_decision_with(
    agent: ureq::Agent,
    base_url: String,
    request_id: &str,
    body: Value,
) -> crate::core::Result<Value> {
    let request_id = request_id.to_string();
    tokio::task::spawn_blocking(move || {
        send_json_value(
            idempotent(authorize(
                agent.post(&format!("{base_url}/v1/requests/{request_id}/decisions")),
            )),
            &body,
        )
    })
    .await
    .map_err(|error| crate::core::NibError::Other(format!("Portal decision task failed: {error}")))?
    .map_err(crate::core::NibError::Other)
}

pub(crate) async fn watch_request_values(
    request_id: &str,
    timeout_seconds: u64,
) -> crate::core::Result<Vec<Value>> {
    let agent = portal_agent();
    let base_url = portal_url();
    let first = get_v1_request_value_with(agent.clone(), base_url.clone(), request_id).await?;
    if timeout_seconds == 0 {
        return Ok(vec![first]);
    }
    let events = get_v1_request_events_with(agent, base_url, request_id).await?;
    Ok(vec![first, events])
}

async fn get_v1_request_events_with(
    agent: ureq::Agent,
    base_url: String,
    request_id: &str,
) -> crate::core::Result<Value> {
    let request_id = request_id.to_string();
    tokio::task::spawn_blocking(move || {
        authorize(agent.get(&format!("{base_url}/v1/requests/{request_id}/events")))
            .call()
            .map_err(http_error)?
            .into_json()
            .map_err(|error| format!("Invalid portal response: {error}"))
    })
    .await
    .map_err(|error| crate::core::NibError::Other(format!("Portal watch task failed: {error}")))?
    .map_err(crate::core::NibError::Other)
}

fn idempotent(request: ureq::Request) -> ureq::Request {
    let key = std::env::var("NIB_IDEMPOTENCY_KEY").unwrap_or_else(|_| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("nib-cli-{}-{nanos}", std::process::id())
    });
    request.set("Idempotency-Key", &key)
}

async fn wait_for_request_with(
    agent: ureq::Agent,
    base_url: String,
    request_id: &str,
    timeout_seconds: u64,
) -> Result<Value, WaitError> {
    let started = Instant::now();
    let mut last_heartbeat = Instant::now();
    let mut retry_delay = Duration::from_millis(500);
    let url = request_url(&base_url, request_id);

    loop {
        if timeout_seconds > 0 && started.elapsed() >= Duration::from_secs(timeout_seconds) {
            return Err(WaitError::TimedOut {
                request_id: request_id.to_string(),
                url,
                timeout_seconds,
            });
        }
        let read_agent = agent.clone();
        let read_base_url = base_url.clone();
        let read_request_id = request_id.to_string();
        let read = tokio::task::spawn_blocking(move || {
            get_request(&read_agent, &read_base_url, &read_request_id)
        })
        .await
        .map_err(|error| WaitError::Fatal(format!("Portal read task failed: {error}")))?;
        match read {
            Ok(request) => {
                retry_delay = Duration::from_millis(500);
                if let Some(response) = request.responses.into_iter().next() {
                    return Ok(response_payload(response));
                }
                if matches!(
                    request.status.as_str(),
                    "stale" | "expired" | "answered" | "acted" | "resolved" | "canceled"
                ) {
                    return Err(WaitError::Terminal {
                        request_id: request_id.to_string(),
                        url,
                        status: request.status,
                    });
                }
            }
            Err(ReadError::Retryable(message)) => {
                if last_heartbeat.elapsed() >= Duration::from_secs(30) {
                    eprintln!(
                        "Still waiting for request {request_id}; portal read failed and will retry: {message}"
                    );
                    last_heartbeat = Instant::now();
                }
                tokio::time::sleep(capped_delay(started, timeout_seconds, retry_delay)).await;
                retry_delay = (retry_delay * 2).min(Duration::from_secs(5));
                continue;
            }
            Err(ReadError::Fatal(message)) => return Err(WaitError::Fatal(message)),
        }

        if last_heartbeat.elapsed() >= Duration::from_secs(30) {
            eprintln!(
                "Still waiting for request {request_id}. Resume from another process with: nib request wait {request_id}"
            );
            last_heartbeat = Instant::now();
        }
        tokio::time::sleep(capped_delay(
            started,
            timeout_seconds,
            Duration::from_millis(500),
        ))
        .await;
    }
}

fn capped_delay(started: Instant, timeout_seconds: u64, delay: Duration) -> Duration {
    if timeout_seconds == 0 {
        return delay;
    }
    Duration::from_secs(timeout_seconds)
        .saturating_sub(started.elapsed())
        .min(delay)
}

fn request_url(base_url: &str, request_id: &str) -> String {
    format!("{base_url}/r/{request_id}")
}

fn get_request(
    agent: &ureq::Agent,
    base_url: &str,
    request_id: &str,
) -> Result<PortalRequest, ReadError> {
    match authorize(agent.get(&format!("{base_url}/api/requests/{request_id}"))).call() {
        Ok(response) => response
            .into_json()
            .map_err(|error| ReadError::Retryable(format!("Invalid portal response: {error}"))),
        Err(ureq::Error::Status(status, response)) if is_retryable_status(status) => {
            let body = response.into_string().unwrap_or_default();
            Err(ReadError::Retryable(format!("HTTP {status}: {body}")))
        }
        Err(ureq::Error::Transport(error)) => Err(ReadError::Retryable(format!(
            "Nib portal is unavailable: {error}"
        ))),
        Err(error) => Err(ReadError::Fatal(http_error(error))),
    }
}

fn get_v1_request_json(
    agent: &ureq::Agent,
    base_url: &str,
    request_id: &str,
) -> Result<Value, String> {
    authorize(agent.get(&format!("{base_url}/v1/requests/{request_id}")))
        .call()
        .map_err(http_error)?
        .into_json()
        .map_err(|error| format!("Invalid portal response: {error}"))
}

fn is_retryable_status(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

fn response_payload(response: PortalResponse) -> Value {
    let mut payload = response.data.unwrap_or(response.raw);
    if let Value::Object(object) = &mut payload {
        if !response.attachments.is_empty() {
            object.insert(
                "attachments".to_string(),
                Value::Array(response.attachments),
            );
        }
        if let Some(transcript) = response.transcript {
            object.insert("transcript".to_string(), transcript);
        }
    }
    payload
}

fn visual_response(response: &Value) -> Result<VisualResponse, String> {
    let response: VisualResponse = serde_json::from_value(response.clone())
        .map_err(|error| format!("Invalid visual review response: {error}"))?;
    if response.contract != "nib.visual-review/v1" && response.contract != "nib.review/v2" {
        return Err(format!(
            "Unsupported visual review contract: {}",
            response.contract
        ));
    }
    Ok(response)
}

#[derive(Debug)]
enum ReadError {
    Retryable(String),
    Fatal(String),
}

fn send_json<T: for<'de> Deserialize<'de>>(
    request: ureq::Request,
    body: &Value,
) -> Result<T, String> {
    request
        .send_json(body)
        .map_err(http_error)?
        .into_json()
        .map_err(|error| format!("Invalid portal response: {error}"))
}

fn send_json_value(request: ureq::Request, body: &Value) -> Result<Value, String> {
    send_json(request, body)
}

fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            format!("Nib portal returned HTTP {status}: {body}")
        }
        ureq::Error::Transport(error) => format!("Nib portal is unavailable: {error}"),
    }
}

fn render_preview(nib_path: &Path) -> Result<Vec<u8>, String> {
    let nib = NibFile::open(nib_path).map_err(|error| error.to_string())?;
    let annotations = nib.list_annotations().map_err(|error| error.to_string())?;
    let assets = nib.get_all_assets().map_err(|error| error.to_string())?;
    let (image_data, image_info) = nib.get_image().map_err(|error| error.to_string())?;
    let image = NibImage {
        image_data,
        width: image_info.width,
        height: image_info.height,
        source: ImageSource::File(nib_path.to_path_buf()),
        annotations,
        assets,
        title: None,
        description: None,
        tags: Vec::new(),
        file_path: Some(nib_path.to_path_buf()),
        created_at: SystemTime::now(),
        modified_at: SystemTime::now(),
    };
    export::encode_composited_png(&image, &export::ExportOptions::default())
        .map_err(|error| error.to_string())
}

fn apply_prompt_annotations(nib_path: &Path, raw: Option<&str>) -> Result<(), String> {
    let Some(raw) = raw else {
        return Ok(());
    };
    let inputs = super::annotation_json::parse_annotations(raw)?;
    let nib = NibFile::open(nib_path).map_err(|error| error.to_string())?;
    for input in inputs {
        let annotation =
            crate::collab::operation::data_to_annotation(0, &input.to_annotation_data());
        nib.add_annotation(&annotation)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn merge_annotations(nib_path: &Path, annotations: &[Value]) -> Result<(), String> {
    let nib = NibFile::open(nib_path).map_err(|error| error.to_string())?;
    for value in annotations {
        let serialized: crate::SerializedAnnotation = serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid image annotation: {error}"))?;
        let annotation = crate::deserialize_annotation(&serialized).ok_or_else(|| {
            format!(
                "Unsupported web annotation type: {}",
                serialized.annotation_type
            )
        })?;
        nib.add_annotation(&annotation)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn request_source() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .unwrap_or_else(|| "unknown-host".to_string());
    match std::env::var("TMUX_PANE") {
        Ok(pane) => format!("{host} / tmux:{pane}"),
        Err(_) => host,
    }
}

#[derive(Debug, Deserialize)]
struct PortalRequest {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    prompt: String,
    #[serde(default = "default_request_status")]
    status: String,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    attachments: Vec<PortalAttachment>,
    #[serde(default)]
    responses: Vec<PortalResponse>,
}

#[derive(Debug, Deserialize)]
struct PortalAttachment {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "contentType")]
    content_type: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Deserialize)]
struct PortalResponse {
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    attachments: Vec<Value>,
    #[serde(default)]
    transcript: Option<Value>,
    #[serde(flatten)]
    raw: Value,
}

fn default_request_status() -> String {
    "open".to_string()
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct VisualResponse {
    contract: String,
    decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comment: Option<String>,
    #[serde(default)]
    annotations: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transcript: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::thread;

    #[test]
    fn web_response_uses_the_versioned_visual_contract() {
        let response: VisualResponse = serde_json::from_value(json!({
            "contract":"nib.visual-review/v1",
            "decision":"approve",
            "annotations":[]
        }))
        .unwrap();
        assert_eq!(response.contract, "nib.visual-review/v1");
        assert_eq!(response.decision, "approve");
    }

    #[test]
    fn retryable_http_statuses_match_the_wait_contract() {
        assert!(is_retryable_status(408));
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(503));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(404));
    }

    #[test]
    fn returned_annotations_are_merged_into_the_originating_nib() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("review.nib");
        NibFile::create(&path, b"image", "png", 100, 80).unwrap();
        let annotation = serde_json::from_value(json!({
            "id":"web-1",
            "type":"rectangle",
            "x":10,
            "y":12,
            "width":30,
            "height":20,
            "color":"#ff0000"
        }))
        .unwrap();

        merge_annotations(&path, &[annotation]).unwrap();

        let annotations = NibFile::open(&path).unwrap().list_annotations().unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].annotation_type.type_name(), "box");
    }

    #[tokio::test]
    async fn durable_wait_returns_an_immediate_response() {
        let base_url = mock_portal(vec![(
            200,
            json!({
                "id":"req-1",
                "status":"answered",
                "responses":[{
                    "data":{"contract":"nib.review/v2","decision":"comment"},
                    "attachments":[{"id":"reply-video","contentType":"video/mp4"}],
                    "transcript":{"status":"unavailable","source":"none"}
                }]
            })
            .to_string(),
        )]);

        let response = wait_for_request_with(portal_agent(), base_url, "req-1", 2)
            .await
            .unwrap();
        assert_eq!(response["decision"], "comment");
        assert_eq!(response["attachments"][0]["id"], "reply-video");
        assert_eq!(response["transcript"]["status"], "unavailable");
    }

    #[tokio::test]
    async fn durable_wait_retries_a_transient_portal_failure() {
        let base_url = mock_portal(vec![
            (503, "temporarily unavailable".to_string()),
            (
                200,
                json!({
                    "id":"req-2",
                    "status":"answered",
                    "responses":[{"text":"Ship it"}]
                })
                .to_string(),
            ),
        ]);

        let response = wait_for_request_with(portal_agent(), base_url, "req-2", 2)
            .await
            .unwrap();
        assert_eq!(response["text"], "Ship it");
    }

    #[tokio::test]
    async fn durable_wait_can_resume_the_same_request_after_process_loss() {
        let base_url = mock_portal(vec![
            (
                200,
                json!({"id":"req-resume","status":"open","responses":[]}).to_string(),
            ),
            (
                200,
                json!({"id":"req-resume","status":"open","responses":[]}).to_string(),
            ),
            (
                200,
                json!({
                    "id":"req-resume",
                    "status":"answered",
                    "responses":[{"choice":"approve"}]
                })
                .to_string(),
            ),
        ]);

        let first = wait_for_request_with(portal_agent(), base_url.clone(), "req-resume", 1)
            .await
            .unwrap_err();
        assert!(matches!(first, WaitError::TimedOut { .. }));

        let resumed = wait_for_request_with(portal_agent(), base_url, "req-resume", 2)
            .await
            .unwrap();
        assert_eq!(resumed["choice"], "approve");
    }

    #[tokio::test]
    async fn explicit_timeout_is_an_error_with_a_resume_command() {
        let responses = (0..4)
            .map(|_| {
                (
                    200,
                    json!({"id":"req-3","status":"open","responses":[]}).to_string(),
                )
            })
            .collect();
        let base_url = mock_portal(responses);

        let error = wait_for_request_with(portal_agent(), base_url, "req-3", 1)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("nib request wait req-3"));
    }

    #[tokio::test]
    async fn durable_wait_retries_transport_failures_until_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        let error = wait_for_request_with(
            portal_agent(),
            format!("http://{address}"),
            "req-offline",
            1,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, WaitError::TimedOut { .. }));
    }

    #[tokio::test]
    async fn resolved_without_a_response_is_terminal() {
        let base_url = mock_portal(vec![(
            200,
            json!({"id":"req-4","status":"resolved","responses":[]}).to_string(),
        )]);

        let error = wait_for_request_with(portal_agent(), base_url, "req-4", 2)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("terminal status 'resolved'"));
    }

    #[tokio::test]
    async fn canceled_without_a_response_is_terminal() {
        let base_url = mock_portal(vec![(
            200,
            json!({"id":"req-canceled","status":"canceled","responses":[]}).to_string(),
        )]);

        let error = wait_for_request_with(portal_agent(), base_url, "req-canceled", 2)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("terminal status 'canceled'"));
    }

    #[tokio::test]
    async fn v1_request_helpers_use_stable_routes_and_canonical_payloads() {
        let (base_url, requests) = mock_portal_capture(vec![
            json!({"request":{"id":"req-created"}}).to_string(),
            json!({"request":{"id":"req-1"}}).to_string(),
            json!({"revision":{"requestRevision":2}}).to_string(),
            json!({"decision":{"outcome":"approved","requestRevision":2}}).to_string(),
            json!({"events":[]}).to_string(),
        ]);
        let agent = portal_agent();

        post_v1_request_value_with(
            agent.clone(),
            base_url.clone(),
            json!({"formatVersion":"1.0","id":"req_json","revision":1}),
        )
        .await
        .unwrap();
        get_v1_request_value_with(agent.clone(), base_url.clone(), "req-1")
            .await
            .unwrap();
        revise_v1_request_value_with(
            agent.clone(),
            base_url.clone(),
            "req-1",
            json!({"metadata":{"phase":"qa"}}),
        )
        .await
        .unwrap();
        create_v1_decision_with(
            agent.clone(),
            base_url.clone(),
            "req-1",
            decision_payload("approved", Some("Looks right")),
        )
        .await
        .unwrap();
        get_v1_request_events_with(agent, base_url, "req-1")
            .await
            .unwrap();

        let create = requests.recv().unwrap();
        assert!(request_line(&create).starts_with("POST /v1/requests "));
        assert!(create
            .to_ascii_lowercase()
            .contains("\r\nidempotency-key: nib-cli-"));
        assert_eq!(request_body_json(&create)["formatVersion"], "1.0");

        let get = requests.recv().unwrap();
        assert!(request_line(&get).starts_with("GET /v1/requests/req-1 "));

        let revise = requests.recv().unwrap();
        assert!(request_line(&revise).starts_with("POST /v1/requests/req-1/revisions "));
        assert!(revise
            .to_ascii_lowercase()
            .contains("\r\nidempotency-key: nib-cli-"));
        assert_eq!(request_body_json(&revise)["metadata"]["phase"], "qa");

        let decision = requests.recv().unwrap();
        assert!(request_line(&decision).starts_with("POST /v1/requests/req-1/decisions "));
        assert!(decision
            .to_ascii_lowercase()
            .contains("\r\nidempotency-key: nib-cli-"));
        let decision_body = request_body_json(&decision);
        assert_eq!(decision_body["outcome"], "approved");
        assert_eq!(decision_body["terminal"], true);
        assert_eq!(decision_body["comment"], "Looks right");
        assert!(decision_body.get("decision").is_none());

        let events = requests.recv().unwrap();
        assert!(request_line(&events).starts_with("GET /v1/requests/req-1/events "));
    }

    #[test]
    fn cancel_uses_canonical_v1_cancelled_status() {
        assert_eq!(cancel_revision_body()["status"], "cancelled");
    }

    fn mock_portal(responses: Vec<(u16, String)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request);
                let reason = if status == 200 {
                    "OK"
                } else {
                    "Service Unavailable"
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        format!("http://{address}")
    }

    fn mock_portal_capture(responses: Vec<String>) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for body in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_request(&mut stream);
                tx.send(request).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (format!("http://{address}"), rx)
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 1024];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let Some(header_end) = find_header_end(&buffer) else {
                continue;
            };
            let headers = String::from_utf8_lossy(&buffer[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buffer.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    fn find_header_end(buffer: &[u8]) -> Option<usize> {
        buffer.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn request_line(request: &str) -> &str {
        request.lines().next().unwrap_or("")
    }

    fn request_body_json(request: &str) -> Value {
        let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
        serde_json::from_str(body).unwrap()
    }
}
