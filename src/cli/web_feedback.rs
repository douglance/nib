use super::{commands::ensure_feedback_nib, FeedbackArgs};
use crate::core::{ImageSource, NibImage};
use crate::storage::{export, nib_file::NibFile};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

const DEFAULT_PORTAL_URL: &str = "https://dave.tail5d92b4.ts.net";

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

pub fn run(args: &FeedbackArgs) -> Result<(), WebFeedbackError> {
    let nib_path = ensure_feedback_nib(&args.file)
        .map_err(|error| WebFeedbackError::after_publish(error.to_string()))?;
    let base_url = portal_url();
    let agent = portal_agent();
    let request = create_request(&agent, &base_url, args, &nib_path)
        .map_err(WebFeedbackError::before_publish)?;
    apply_prompt_annotations(&nib_path, args.annotations.as_deref())
        .map_err(WebFeedbackError::after_publish)?;
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

    let review_url = format!("{base_url}/r/{}", request.id);
    if args.detach {
        println!(
            "{}",
            json!({"event":"review_opening","request":request.id,"url":review_url,"file":nib_path})
        );
        return Ok(());
    }

    match wait_for_response(&agent, &base_url, &request.id, args.timeout) {
        Ok(Some(response)) => {
            merge_annotations(&nib_path, &response.annotations)
                .map_err(WebFeedbackError::after_publish)?;
            println!("{}", serde_json::to_string(&response).unwrap_or_default());
            Ok(())
        }
        Ok(None) => {
            println!(
                "{}",
                json!({"event":"timeout","request":request.id,"url":review_url})
            );
            Ok(())
        }
        Err(error) => Err(WebFeedbackError::after_publish(error)),
    }
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

fn create_request(
    agent: &ureq::Agent,
    base_url: &str,
    args: &FeedbackArgs,
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
    let prompt = args.message.as_deref().unwrap_or("Review this image");
    let body = json!({
        "kind": "visual-review",
        "title": title,
        "prompt": prompt,
        "source": request_source(),
        "metadata": {"contract":"nib.visual-review/v1","fileName":file_name},
        "notify": false
    });
    send_json(agent.post(&format!("{base_url}/api/requests")), &body)
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
        agent.post(&format!("{base_url}/api/requests/{request_id}/attachments")),
        &body,
    )?;
    Ok(())
}

fn publish_request(agent: &ureq::Agent, base_url: &str, request_id: &str) -> Result<(), String> {
    agent
        .post(&format!("{base_url}/api/requests/{request_id}/publish"))
        .call()
        .map(|_| ())
        .map_err(http_error)
}

fn wait_for_response(
    agent: &ureq::Agent,
    base_url: &str,
    request_id: &str,
    timeout_seconds: u64,
) -> Result<Option<VisualResponse>, String> {
    let started = Instant::now();
    loop {
        let request: PortalRequest = agent
            .get(&format!("{base_url}/api/requests/{request_id}"))
            .call()
            .map_err(http_error)?
            .into_json()
            .map_err(|error| format!("Invalid portal response: {error}"))?;
        if let Some(response) = request
            .responses
            .into_iter()
            .next()
            .and_then(|response| response.data)
        {
            if response.contract != "nib.visual-review/v1" {
                return Err(format!(
                    "Unsupported visual review contract: {}",
                    response.contract
                ));
            }
            return Ok(Some(response));
        }
        if timeout_seconds > 0 && started.elapsed() >= Duration::from_secs(timeout_seconds) {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
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

fn merge_annotations(
    nib_path: &Path,
    annotations: &[crate::SerializedAnnotation],
) -> Result<(), String> {
    let nib = NibFile::open(nib_path).map_err(|error| error.to_string())?;
    for serialized in annotations {
        let annotation = crate::deserialize_annotation(serialized).ok_or_else(|| {
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
    responses: Vec<PortalResponse>,
}

#[derive(Debug, Deserialize)]
struct PortalResponse {
    data: Option<VisualResponse>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
struct VisualResponse {
    contract: String,
    decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comment: Option<String>,
    #[serde(default)]
    annotations: Vec<crate::SerializedAnnotation>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
