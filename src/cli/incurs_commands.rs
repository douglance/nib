//! Canonical Incurs command graph for the `nib` CLI and MCP server.
//!
//! Typed commands own the request, recording, and media contracts. Commands
//! that still use print-oriented implementations run through a private
//! compatibility adapter without exposing a second public parser.

use super::{
    fields, AwaitSubmitArgs, FeedbackArgs, FeedbackUi, RecordStartArgs, RequestReviewArgs,
    ReviewArgs,
};
use async_trait::async_trait;
use incurs::{
    cli::Cli,
    command::{
        CommandContext, CommandDef, CommandHandler, Example, McpAnnotations, McpCommandOptions,
        TypedContext, TypedResult,
    },
    output::{CommandResult, CtaBlock, CtaEntry, Format},
    schema::FieldType,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};

struct FeedbackHandler;
struct ReviewHandler;
struct AwaitSubmitHandler;
struct CreateReviewHandler;
struct StartRecordingHandler;
struct RecordingStatusHandler;
struct StopRecordingHandler;
struct WaitRecordingHandler;
struct InspectMediaHandler;
struct PosterMediaHandler;
struct TranscribeMediaHandler;

#[derive(Debug, Deserialize, incurs::Args)]
struct AuthRedeemArgs {
    /// One-time pairing code.
    code: String,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct AuthPortalOptions {
    /// Nib service URL; defaults to NIB_PORTAL_URL or the global service.
    portal: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct AuthLoginOptions {
    /// Nib service URL; defaults to NIB_PORTAL_URL or the global service.
    portal: Option<String>,
    /// Human-readable name for this CLI credential.
    name: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct AuthRedeemOptions {
    /// Nib service URL; defaults to NIB_PORTAL_URL or the global service.
    portal: Option<String>,
    /// Human-readable name for this credential.
    name: Option<String>,
    /// Client platform recorded by the service.
    platform: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct AuthIssueOptions {
    /// Nib service URL; defaults to NIB_PORTAL_URL or the global service.
    portal: Option<String>,
    /// Human-readable name for the service credential.
    name: Option<String>,
    /// Service platform; defaults to cloudflare-codemode.
    platform: Option<String>,
}

struct CompatHandler {
    path: Vec<String>,
    args_fields: Vec<incurs::schema::FieldMeta>,
    options_fields: Vec<incurs::schema::FieldMeta>,
}

#[derive(Debug, Deserialize, incurs::Options)]
#[allow(dead_code)]
pub(crate) struct GlobalOptions {
    /// Increase diagnostic logging; repeat for trace logging.
    #[incurs(alias = "v", count)]
    pub verbose: u8,
}

#[derive(Debug, Deserialize, incurs::Env)]
#[allow(dead_code)]
pub(crate) struct NibEnv {
    /// Portal used for durable human requests.
    #[incurs(env = "NIB_PORTAL_URL")]
    pub portal_url: Option<String>,
    /// Portal connection timeout in milliseconds.
    #[incurs(env = "NIB_PORTAL_CONNECT_TIMEOUT_MS")]
    pub portal_connect_timeout_ms: Option<u64>,
    /// Bootstrap or automation bearer token; normal credentials use Keychain.
    #[incurs(env = "NIB_AUTH_TOKEN")]
    pub auth_token: Option<String>,
    /// Image generator command override.
    #[incurs(env = "NIB_GENERATE_COMMAND")]
    pub generate_command: Option<String>,
    /// Visual judge command override.
    #[incurs(env = "NIB_JUDGE_COMMAND")]
    pub judge_command: Option<String>,
    /// tmux executable override.
    #[incurs(env = "NIB_TMUX_BIN")]
    pub tmux_bin: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Args)]
struct FileArgs {
    /// Input media file.
    file: PathBuf,
}

#[derive(Debug, Deserialize, incurs::Args)]
struct OptionalRecordingArgs {
    /// Recording ID; omit to select the active recording.
    recording_id: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Args)]
struct RecordingArgs {
    /// Recording ID.
    recording_id: String,
}

#[derive(Debug, Deserialize, incurs::Args)]
struct RequestArgs {
    /// Durable request ID.
    request_id: String,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct CreateRequestOptions {
    /// Question shown to the reviewer.
    #[incurs(alias = "m")]
    question: Option<String>,
    /// Image-only annotation prompt JSON.
    #[incurs(alias = "a")]
    annotations: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct WaitOptions {
    /// Seconds to wait; zero waits indefinitely.
    #[incurs(alias = "t", default = 0)]
    timeout: u64,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct ReviewRequestOptions {
    /// Portal base URL.
    portal: Option<String>,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct RecordStartOptions {
    /// Output MP4 path.
    output: Option<PathBuf>,
    /// Stop automatically after this many seconds.
    duration: Option<u64>,
    /// Record a display number.
    display: Option<u32>,
    /// Record a CoreGraphics window ID.
    window: Option<u32>,
    /// Record x,y,width,height.
    region: Option<String>,
    /// Let the user select a target.
    #[incurs(default = false)]
    interactive: bool,
    /// Include system audio.
    #[incurs(default = false)]
    system_audio: bool,
    /// Include the default microphone.
    #[incurs(default = false)]
    microphone: bool,
    /// Include the cursor.
    #[incurs(default = true)]
    cursor: bool,
    /// Show pointer clicks.
    #[incurs(default = false)]
    show_clicks: bool,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct PosterOptions {
    /// Output PNG path.
    output: Option<PathBuf>,
}

#[derive(Debug, Deserialize, incurs::Options)]
struct TranscriptOptions {
    /// BCP-47 locale hint.
    locale: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PosterOutput {
    file: PathBuf,
    content_type: String,
}

struct PolicyHandler {
    inner: Box<dyn CommandHandler>,
    options: McpCommandOptions,
}

#[derive(Clone, Copy)]
struct Policy {
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
    mcp_name: Option<&'static str>,
}

const LOCAL_READ: Policy = Policy {
    read_only: true,
    destructive: false,
    idempotent: true,
    open_world: false,
    mcp_name: None,
};

const LOCAL_EFFECT: Policy = Policy {
    read_only: false,
    destructive: false,
    idempotent: false,
    open_world: false,
    mcp_name: None,
};

const EXTERNAL_EFFECT: Policy = Policy {
    read_only: false,
    destructive: false,
    idempotent: false,
    open_world: true,
    mcp_name: None,
};

#[async_trait]
impl CommandHandler for PolicyHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        self.inner.run(ctx).await
    }

    fn mcp_options(&self) -> Option<&McpCommandOptions> {
        Some(&self.options)
    }
}

#[async_trait]
impl CommandHandler for CompatHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let executable = match std::env::current_exe() {
            Ok(executable) => executable,
            Err(io_error) => return error(io_error),
        };
        let path = self.path.clone();
        let args_fields = self.args_fields.clone();
        let options_fields = self.options_fields.clone();
        let args = ctx.args;
        let options = ctx.options;
        let legacy_json = matches!(ctx.format, Format::Json | Format::Jsonl);
        let output = tokio::task::spawn_blocking(move || {
            let mut command = ProcessCommand::new(executable);
            command.env("NIB_CLAP_COMPAT", "1");
            if legacy_json {
                command.args(["--format", "json"]);
            }
            command.args(&path).stdin(Stdio::inherit());
            for field in &args_fields {
                if let Some(value) = args.get(field.name) {
                    append_values(&mut command, value);
                }
            }
            for field in &options_fields {
                let Some(value) = options.get(field.name) else {
                    continue;
                };
                let cli_name = if path == ["tile", "list"] && field.cli_name == "details" {
                    "verbose"
                } else {
                    field.cli_name.as_str()
                };
                match value {
                    Value::Bool(true) => {
                        command.arg(format!("--{cli_name}"));
                    }
                    Value::Bool(false) | Value::Null => {}
                    Value::Array(values) => {
                        for value in values {
                            command.arg(format!("--{cli_name}"));
                            append_values(&mut command, value);
                        }
                    }
                    value => {
                        command.arg(format!("--{cli_name}"));
                        append_values(&mut command, value);
                    }
                }
            }
            command.output()
        })
        .await;

        let output = match output {
            Ok(Ok(output)) => output,
            Ok(Err(io_error)) => return error(io_error),
            Err(join_error) => return error(join_error),
        };
        if !output.stderr.is_empty() {
            let _ = std::io::stderr().write_all(&output.stderr);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !output.status.success() {
            return CommandResult::Error {
                code: "NIB_COMMAND_FAILED".into(),
                message: if stdout.is_empty() {
                    format!("command exited with {}", output.status)
                } else {
                    stdout
                },
                retryable: false,
                exit_code: output.status.code().or(Some(1)),
                cta: None,
            };
        }
        if stdout.is_empty() {
            return ok(json!({"completed": true}));
        }
        match serde_json::from_str::<Value>(&stdout) {
            Ok(value) => ok(value),
            Err(_) => ok(json!({"output": stdout})),
        }
    }
}

fn append_values(command: &mut ProcessCommand, value: &Value) {
    match value {
        Value::String(value) => {
            command.arg(value);
        }
        Value::Number(value) => {
            command.arg(value.to_string());
        }
        Value::Bool(value) => {
            command.arg(value.to_string());
        }
        Value::Array(values) => {
            for value in values {
                append_values(command, value);
            }
        }
        Value::Null => {}
        value => {
            command.arg(value.to_string());
        }
    }
}

fn error(message: impl ToString) -> CommandResult {
    CommandResult::Error {
        code: "NIB_ERROR".into(),
        message: message.to_string(),
        retryable: false,
        exit_code: Some(1),
        cta: None,
    }
}

fn ui(value: Option<&Value>) -> Result<FeedbackUi, CommandResult> {
    match value.and_then(Value::as_str).unwrap_or("native") {
        "native" | "gui" => Ok(FeedbackUi::Native),
        "terminal" => Ok(FeedbackUi::Terminal),
        "web" => Ok(FeedbackUi::Web),
        "auto" => Ok(FeedbackUi::Auto),
        other => Err(error(format!("invalid --ui value: {other}"))),
    }
}

#[async_trait]
impl CommandHandler for FeedbackHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let file = match fields::path_arg(&ctx.args, "file") {
            Ok(file) => file,
            Err(result) => return result,
        };
        let args = FeedbackArgs {
            file,
            message: ctx
                .options
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
            annotations: ctx
                .options
                .get("annotations")
                .and_then(Value::as_str)
                .map(str::to_owned),
            timeout: ctx
                .options
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            ui: match ui(ctx.options.get("ui")) {
                Ok(ui) => ui,
                Err(result) => return result,
            },
            detach: ctx
                .options
                .get("detach")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        if args.ui == FeedbackUi::Native {
            match super::commands::run_native_feedback_value(&args).await {
                Ok(value) => ok(value),
                Err(feedback_error) => error(feedback_error),
            }
        } else {
            match super::commands::run_feedback(&args).await {
                Ok(()) => CommandResult::Ok {
                    data: json!({"completed": true}),
                    cta: None,
                    exit_code: None,
                },
                Err(command_error) => error(command_error),
            }
        }
    }
}

#[async_trait]
impl CommandHandler for ReviewHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let session = match fields::path_arg(&ctx.args, "session") {
            Ok(file) => file,
            Err(result) => return result,
        };
        let args = ReviewArgs {
            session,
            message: ctx
                .options
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        match super::commands::run_review(&args).await {
            Ok(()) => CommandResult::Ok {
                data: json!({"completed": true}),
                cta: None,
                exit_code: None,
            },
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for AwaitSubmitHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let file = match fields::path_arg(&ctx.args, "session") {
            Ok(file) => file,
            Err(result) => return result,
        };
        let args = AwaitSubmitArgs {
            file,
            stream: false,
            timeout: ctx
                .options
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(30),
            json: true,
            interval: ctx
                .options
                .get("interval")
                .and_then(Value::as_u64)
                .unwrap_or(100),
            feedback: ctx
                .options
                .get("feedback")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        };
        match super::commands::run_await_submit(&args).await {
            Ok(()) => CommandResult::Ok {
                data: json!({"completed": true}),
                cta: None,
                exit_code: None,
            },
            Err(err) => error(err),
        }
    }
}

fn ok(value: impl serde::Serialize) -> CommandResult {
    match serde_json::to_value(value) {
        Ok(data) => CommandResult::Ok {
            data,
            cta: None,
            exit_code: None,
        },
        Err(serialization_error) => error(serialization_error),
    }
}

#[async_trait]
impl CommandHandler for CreateReviewHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let file = match fields::path_arg(&ctx.args, "file") {
            Ok(file) => file,
            Err(result) => return result,
        };
        let question = ctx
            .options
            .get("question")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let annotations = ctx
            .options
            .get("annotations")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match tokio::task::spawn_blocking(move || {
            super::web_feedback::create_review_request(
                &file,
                question.as_deref(),
                annotations.as_deref(),
            )
        })
        .await
        {
            Ok(Ok(result)) => ok(result),
            Ok(Err(err)) => error(err),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for StartRecordingHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let args = RecordStartArgs {
            output: fields::optional_path_arg(&ctx.options, "output"),
            duration: ctx.options.get("duration").and_then(Value::as_u64),
            display: ctx
                .options
                .get("display")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            window: ctx
                .options
                .get("window")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok()),
            region: ctx
                .options
                .get("region")
                .and_then(Value::as_str)
                .map(str::to_owned),
            interactive: boolean(&ctx.options, "interactive", false),
            system_audio: boolean(&ctx.options, "systemAudio", false),
            microphone: boolean(&ctx.options, "microphone", false),
            no_cursor: !boolean(&ctx.options, "cursor", true),
            show_clicks: boolean(&ctx.options, "showClicks", false),
        };
        match crate::media::start_recording(&args) {
            Ok(state) => ok(state),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for RecordingStatusHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let id = ctx.args.get("recordingId").and_then(Value::as_str);
        match crate::media::recording_status(id) {
            Ok(state) => ok(state),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for StopRecordingHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let id = ctx.args.get("recordingId").and_then(Value::as_str);
        match crate::media::stop_recording(id) {
            Ok(state) => ok(state),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for WaitRecordingHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let Some(id) = ctx.args.get("recordingId").and_then(Value::as_str) else {
            return error("recordingId is required");
        };
        let timeout = ctx
            .options
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        match crate::media::wait_for_recording(id, timeout).await {
            Ok(state) => ok(state),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for InspectMediaHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let file = match fields::path_arg(&ctx.args, "file") {
            Ok(file) => file,
            Err(result) => return result,
        };
        match crate::media::inspect_media(&file) {
            Ok(info) => ok(info),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for PosterMediaHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let file = match fields::path_arg(&ctx.args, "file") {
            Ok(file) => file,
            Err(result) => return result,
        };
        let output = fields::optional_path_arg(&ctx.options, "output");
        match crate::media::poster_frame(&file, output.as_deref()) {
            Ok(path) => ok(json!({"file":path,"contentType":"image/png"})),
            Err(err) => error(err),
        }
    }
}

#[async_trait]
impl CommandHandler for TranscribeMediaHandler {
    async fn run(&self, ctx: CommandContext) -> CommandResult {
        let file = match fields::path_arg(&ctx.args, "file") {
            Ok(file) => file,
            Err(result) => return result,
        };
        if let Err(err) = crate::media::inspect_media(&file) {
            return error(err);
        }
        ok(json!({
            "status":"unavailable",
            "source":"none",
            "locale":ctx.options.get("locale").and_then(Value::as_str),
            "text":"",
            "segments":[],
            "error":"On-device transcription is unavailable in this build; preserve the media and retry on a Nib Apple client"
        }))
    }
}

fn boolean(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn command(
    name: &str,
    description: &str,
    args_fields: Vec<incurs::schema::FieldMeta>,
    options_fields: Vec<incurs::schema::FieldMeta>,
    handler: Box<dyn CommandHandler>,
) -> CommandDef {
    command_with_policy(
        name,
        description,
        args_fields,
        options_fields,
        handler,
        EXTERNAL_EFFECT,
    )
}

fn read_command(
    name: &str,
    description: &str,
    args_fields: Vec<incurs::schema::FieldMeta>,
    options_fields: Vec<incurs::schema::FieldMeta>,
    handler: Box<dyn CommandHandler>,
) -> CommandDef {
    command_with_policy(
        name,
        description,
        args_fields,
        options_fields,
        handler,
        LOCAL_READ,
    )
}

fn command_with_policy(
    name: &str,
    description: &str,
    args_fields: Vec<incurs::schema::FieldMeta>,
    options_fields: Vec<incurs::schema::FieldMeta>,
    handler: Box<dyn CommandHandler>,
    policy: Policy,
) -> CommandDef {
    let aliases = options_fields
        .iter()
        .filter_map(|field| field.alias.map(|alias| (field.cli_name.clone(), alias)))
        .collect();
    CommandDef {
        name: name.into(),
        description: Some(description.into()),
        args_fields,
        options_fields,
        env_fields: vec![],
        aliases,
        command_aliases: vec![],
        examples: vec![],
        hint: None,
        format: None,
        output_policy: None,
        handler: Box::new(PolicyHandler {
            inner: handler,
            options: McpCommandOptions {
                enabled: true,
                name: policy.mcp_name.map(str::to_owned),
                description: None,
                instructions: None,
                annotations: Some(McpAnnotations {
                    title: None,
                    read_only_hint: Some(policy.read_only),
                    destructive_hint: Some(policy.destructive),
                    idempotent_hint: Some(policy.idempotent),
                    open_world_hint: Some(policy.open_world),
                }),
                destructive: policy.destructive,
                result_content: vec![],
            },
        }),
        middleware: vec![],
        output_schema: None,
    }
}

fn compat_command(
    name: &str,
    description: &str,
    path: &[&str],
    args_fields: Vec<incurs::schema::FieldMeta>,
    options_fields: Vec<incurs::schema::FieldMeta>,
    policy: Policy,
) -> CommandDef {
    let handler = CompatHandler {
        path: path.iter().map(|part| (*part).to_owned()).collect(),
        args_fields: args_fields.clone(),
        options_fields: options_fields.clone(),
    };
    let mut definition = command_with_policy(
        name,
        description,
        args_fields,
        options_fields,
        Box::new(handler),
        policy,
    );
    definition.output_schema = Some(json!({
        "type": "object",
        "description": "Structured compatibility output from the existing Nib command implementation"
    }));
    definition
}

fn documented(
    mut definition: CommandDef,
    examples: &[(&str, &str)],
    hint: Option<&str>,
) -> CommandDef {
    definition.examples = examples
        .iter()
        .map(|(command, description)| Example {
            command: (*command).to_owned(),
            description: Some((*description).to_owned()),
        })
        .collect();
    definition.hint = hint.map(str::to_owned);
    definition
}

fn mcp_options(policy: Policy) -> McpCommandOptions {
    McpCommandOptions {
        enabled: true,
        name: policy.mcp_name.map(str::to_owned),
        description: None,
        instructions: None,
        annotations: Some(McpAnnotations {
            title: None,
            read_only_hint: Some(policy.read_only),
            destructive_hint: Some(policy.destructive),
            idempotent_hint: Some(policy.idempotent),
            open_world_hint: Some(policy.open_world),
        }),
        destructive: policy.destructive,
        result_content: vec![],
    }
}

fn typed_request_group() -> Cli {
    let create = CommandDef::typed::<
        FileArgs,
        CreateRequestOptions,
        (),
        super::web_feedback::PublishedFeedback,
        _,
        _,
    >(
        "create",
        |ctx: TypedContext<FileArgs, CreateRequestOptions, ()>| async move {
            let file = ctx.args.file;
            let question = ctx.options.question;
            let annotations = ctx.options.annotations;
            match tokio::task::spawn_blocking(move || {
                super::web_feedback::create_review_request(
                    &file,
                    question.as_deref(),
                    annotations.as_deref(),
                )
            })
            .await
            {
                Ok(Ok(published)) => {
                    let cta = CtaBlock {
                        commands: vec![CtaEntry::Detailed {
                            command: format!("request wait {}", published.request_id),
                            description: Some("Wait for the final response".into()),
                        }],
                        description: Some("Continue this durable request:".into()),
                    };
                    TypedResult::ok_with_cta(published, cta)
                }
                Ok(Err(request_error)) => {
                    TypedResult::error("REQUEST_CREATE_FAILED", request_error.to_string())
                }
                Err(join_error) => {
                    TypedResult::error("REQUEST_CREATE_FAILED", join_error.to_string())
                }
            }
        },
    )
    .description("Publish a durable image or MP4/H.264 review and return immediately")
    .examples(vec![Example {
        command: "review.mp4 -m \"Check the transition\"".into(),
        description: Some("Publish a nonblocking video review".into()),
    }])
    .hint("Use request wait with the returned request ID.")
    .mcp(mcp_options(Policy {
        mcp_name: Some("create_review_request"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    let wait = CommandDef::typed::<RequestArgs, WaitOptions, (), Value, _, _>(
        "wait",
        |ctx: TypedContext<RequestArgs, WaitOptions, ()>| async move {
            match super::web_feedback::wait_for_request(&ctx.args.request_id, ctx.options.timeout)
                .await
            {
                Ok(response) => TypedResult::ok(response),
                Err(wait_error) => {
                    TypedResult::error("REQUEST_WAIT_FAILED", wait_error.to_string())
                }
            }
        },
    )
    .description("Wait for a durable request to receive its final response")
    .examples(vec![Example {
        command: "req_123".into(),
        description: Some("Resume the same durable request wait".into()),
    }])
    .hint("Timeouts do not create a second request; resume with the same request ID.")
    .mcp(mcp_options(Policy {
        read_only: true,
        idempotent: true,
        open_world: true,
        mcp_name: Some("wait_for_request"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    let review = CommandDef::typed::<RequestArgs, ReviewRequestOptions, (), Value, _, _>(
        "review",
        |ctx: TypedContext<RequestArgs, ReviewRequestOptions, ()>| async move {
            let args = RequestReviewArgs {
                request_id: ctx.args.request_id,
                portal: ctx.options.portal,
            };
            match super::web_feedback::review_request_value(&args).await {
                Ok(response) => TypedResult::ok(response),
                Err(review_error) => {
                    TypedResult::error("REQUEST_REVIEW_FAILED", review_error.to_string())
                }
            }
        },
    )
    .description("Open a durable request in the native Rust reviewer and submit its response")
    .examples(vec![Example {
        command: "req_123".into(),
        description: Some("Review an existing request in the native GPUI window".into()),
    }])
    .mcp(mcp_options(Policy {
        mcp_name: Some("open_review_request"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    Cli::create("request")
        .description("Create, review, and wait for durable human requests")
        .command("create", create)
        .command("review", review)
        .command("wait", wait)
}

fn typed_auth_group() -> Cli {
    let login = CommandDef::typed::<
        (),
        AuthLoginOptions,
        (),
        super::auth::AuthStatus,
        _,
        _,
    >(
        "login",
        |ctx: TypedContext<(), AuthLoginOptions, ()>| async move {
            let portal = ctx
                .options
                .portal
                .unwrap_or_else(super::auth::default_portal);
            let name = ctx.options.name;
            match tokio::task::spawn_blocking(move || super::auth::login(&portal, name.as_deref()))
                .await
            {
                Ok(Ok(status)) => {
                    let cta = CtaBlock {
                        commands: vec![CtaEntry::Detailed {
                            command: "auth status".into(),
                            description: Some("Verify the stored credential".into()),
                        }],
                        description: Some("Authentication is ready:".into()),
                    };
                    TypedResult::ok_with_cta(status, cta)
                }
                Ok(Err(auth_error)) => TypedResult::error("AUTH_LOGIN_FAILED", auth_error),
                Err(join_error) => {
                    TypedResult::error("AUTH_LOGIN_FAILED", join_error.to_string())
                }
            }
        },
    )
    .description("Exchange a one-time bootstrap credential for a scoped Keychain credential")
    .hint("NIB_AUTH_TOKEN is an automation override and one-time enrollment path, not normal client storage.")
    .mcp(mcp_options(Policy {
        mcp_name: Some("auth_login"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    let status = CommandDef::typed::<(), AuthPortalOptions, (), super::auth::AuthStatus, _, _>(
        "status",
        |ctx: TypedContext<(), AuthPortalOptions, ()>| async move {
            let portal = ctx
                .options
                .portal
                .unwrap_or_else(super::auth::default_portal);
            match tokio::task::spawn_blocking(move || super::auth::status(&portal)).await {
                Ok(Ok(status)) => TypedResult::ok(status),
                Ok(Err(auth_error)) => TypedResult::error("AUTH_STATUS_FAILED", auth_error),
                Err(join_error) => TypedResult::error("AUTH_STATUS_FAILED", join_error.to_string()),
            }
        },
    )
    .description("Verify the active Nib credential and report its source and scopes")
    .mcp(mcp_options(Policy {
        read_only: true,
        idempotent: true,
        open_world: true,
        mcp_name: Some("auth_status"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    let logout = CommandDef::typed::<(), AuthPortalOptions, (), super::auth::AuthLogout, _, _>(
        "logout",
        |ctx: TypedContext<(), AuthPortalOptions, ()>| async move {
            let portal = ctx
                .options
                .portal
                .unwrap_or_else(super::auth::default_portal);
            match tokio::task::spawn_blocking(move || super::auth::logout(&portal)).await {
                Ok(Ok(result)) => TypedResult::ok(result),
                Ok(Err(auth_error)) => TypedResult::error("AUTH_LOGOUT_FAILED", auth_error),
                Err(join_error) => TypedResult::error("AUTH_LOGOUT_FAILED", join_error.to_string()),
            }
        },
    )
    .description("Revoke the active scoped token and remove it from Keychain")
    .mcp(mcp_options(Policy {
        destructive: true,
        mcp_name: Some("auth_logout"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    let pair = CommandDef::typed::<(), AuthPortalOptions, (), super::auth::AuthPairing, _, _>(
        "pair",
        |ctx: TypedContext<(), AuthPortalOptions, ()>| async move {
            let portal = ctx
                .options
                .portal
                .unwrap_or_else(super::auth::default_portal);
            match tokio::task::spawn_blocking(move || super::auth::pair(&portal)).await {
                Ok(Ok(pairing)) => {
                    let cta = CtaBlock {
                        commands: vec![CtaEntry::Detailed {
                            command: format!("auth redeem {}", pairing.code),
                            description: Some("Redeem on the device being enrolled".into()),
                        }],
                        description: Some("This code expires and works once:".into()),
                    };
                    TypedResult::ok_with_cta(pairing, cta)
                }
                Ok(Err(auth_error)) => TypedResult::error("AUTH_PAIR_FAILED", auth_error),
                Err(join_error) => TypedResult::error("AUTH_PAIR_FAILED", join_error.to_string()),
            }
        },
    )
    .description("Create a short-lived, one-time code for another Nib client")
    .mcp(mcp_options(Policy {
        mcp_name: Some("auth_pair"),
        ..EXTERNAL_EFFECT
    }))
    .done();

    let redeem =
        CommandDef::typed::<AuthRedeemArgs, AuthRedeemOptions, (), super::auth::AuthStatus, _, _>(
            "redeem",
            |ctx: TypedContext<AuthRedeemArgs, AuthRedeemOptions, ()>| async move {
                let portal = ctx
                    .options
                    .portal
                    .unwrap_or_else(super::auth::default_portal);
                let code = ctx.args.code;
                let name = ctx.options.name;
                let platform = ctx.options.platform;
                match tokio::task::spawn_blocking(move || {
                    super::auth::redeem(&portal, &code, name.as_deref(), platform.as_deref())
                })
                .await
                {
                    Ok(Ok(status)) => TypedResult::ok(status),
                    Ok(Err(auth_error)) => TypedResult::error("AUTH_REDEEM_FAILED", auth_error),
                    Err(join_error) => {
                        TypedResult::error("AUTH_REDEEM_FAILED", join_error.to_string())
                    }
                }
            },
        )
        .description("Redeem a one-time pairing code and store the scoped credential in Keychain")
        .mcp(mcp_options(Policy {
            mcp_name: Some("auth_redeem"),
            ..EXTERNAL_EFFECT
        }))
        .done();

    let issue = CommandDef::typed::<
        (),
        AuthIssueOptions,
        (),
        super::auth::AuthIssuedCredential,
        _,
        _,
    >(
        "issue",
        |ctx: TypedContext<(), AuthIssueOptions, ()>| async move {
            let portal = ctx
                .options
                .portal
                .unwrap_or_else(super::auth::default_portal);
            let name = ctx.options.name;
            let platform = ctx.options.platform;
            match tokio::task::spawn_blocking(move || {
                super::auth::issue_service_token(&portal, name.as_deref(), platform.as_deref())
            })
            .await
            {
                Ok(Ok(credential)) => TypedResult::ok(credential),
                Ok(Err(auth_error)) => TypedResult::error("AUTH_ISSUE_FAILED", auth_error),
                Err(join_error) => {
                    TypedResult::error("AUTH_ISSUE_FAILED", join_error.to_string())
                }
            }
        },
    )
    .description("Issue a least-privilege service token without replacing the CLI credential")
    .hint("The token is shown once. Pipe JSON output directly into the target secret store and do not save it in source control.")
    .done();

    Cli::create("auth")
        .description("Enroll clients and manage scoped Nib credentials")
        .command("login", login)
        .command("status", status)
        .command("logout", logout)
        .command("pair", pair)
        .command("redeem", redeem)
        .command("issue", issue)
}

fn typed_record_group() -> Cli {
    let start = CommandDef::typed::<(), RecordStartOptions, (), crate::media::RecordingState, _, _>(
        "start",
        |ctx: TypedContext<(), RecordStartOptions, ()>| async move {
            let options = ctx.options;
            let args = RecordStartArgs {
                output: options.output,
                duration: options.duration,
                display: options.display,
                window: options.window,
                region: options.region,
                interactive: options.interactive,
                system_audio: options.system_audio,
                microphone: options.microphone,
                no_cursor: !options.cursor,
                show_clicks: options.show_clicks,
            };
            match crate::media::start_recording(&args) {
                Ok(recording) => {
                    let cta = CtaBlock {
                        commands: vec![
                            CtaEntry::Detailed {
                                command: format!("record wait {}", recording.id),
                                description: Some("Wait for completion".into()),
                            },
                            CtaEntry::Detailed {
                                command: format!("record stop {}", recording.id),
                                description: Some("Stop and finalize now".into()),
                            },
                        ],
                        description: Some("Manage this recording:".into()),
                    };
                    TypedResult::ok_with_cta(recording, cta)
                }
                Err(record_error) => {
                    TypedResult::error("RECORDING_START_FAILED", record_error.to_string())
                }
            }
        },
    )
    .description("Start a durable macOS screen recording and return its ID")
    .examples(vec![
        Example {
            command: "--duration 5".into(),
            description: Some("Record five silent seconds".into()),
        },
        Example {
            command: "--system-audio".into(),
            description: Some("Explicitly include system audio".into()),
        },
    ])
    .hint("Recording is silent unless system audio or microphone capture is explicitly requested.")
    .mcp(mcp_options(Policy {
        mcp_name: Some("start_recording"),
        ..LOCAL_EFFECT
    }))
    .done();

    let status =
        CommandDef::typed::<OptionalRecordingArgs, (), (), crate::media::RecordingState, _, _>(
            "status",
            |ctx: TypedContext<OptionalRecordingArgs, (), ()>| async move {
                match crate::media::recording_status(ctx.args.recording_id.as_deref()) {
                    Ok(recording) => TypedResult::ok(recording),
                    Err(record_error) => {
                        TypedResult::error("RECORDING_STATUS_FAILED", record_error.to_string())
                    }
                }
            },
        )
        .description("Read one durable recording or the active recording")
        .mcp(mcp_options(Policy {
            mcp_name: Some("recording_status"),
            ..LOCAL_READ
        }))
        .done();

    let stop =
        CommandDef::typed::<OptionalRecordingArgs, (), (), crate::media::RecordingState, _, _>(
            "stop",
            |ctx: TypedContext<OptionalRecordingArgs, (), ()>| async move {
                match crate::media::stop_recording(ctx.args.recording_id.as_deref()) {
                    Ok(recording) => TypedResult::ok(recording),
                    Err(record_error) => {
                        TypedResult::error("RECORDING_STOP_FAILED", record_error.to_string())
                    }
                }
            },
        )
        .description("Idempotently stop and finalize a durable recording")
        .mcp(mcp_options(Policy {
            idempotent: true,
            mcp_name: Some("stop_recording"),
            ..LOCAL_EFFECT
        }))
        .done();

    let wait =
        CommandDef::typed::<RecordingArgs, WaitOptions, (), crate::media::RecordingState, _, _>(
            "wait",
            |ctx: TypedContext<RecordingArgs, WaitOptions, ()>| async move {
                match crate::media::wait_for_recording(&ctx.args.recording_id, ctx.options.timeout)
                    .await
                {
                    Ok(recording) => TypedResult::ok(recording),
                    Err(record_error) => {
                        TypedResult::error("RECORDING_WAIT_FAILED", record_error.to_string())
                    }
                }
            },
        )
        .description("Wait for a durable recording to complete or fail")
        .mcp(mcp_options(Policy {
            mcp_name: Some("wait_for_recording"),
            ..LOCAL_READ
        }))
        .done();

    Cli::create("record")
        .description("Record the screen and manage durable recording workers")
        .command("start", start)
        .command("status", status)
        .command("stop", stop)
        .command("wait", wait)
}

fn typed_media_group() -> Cli {
    let inspect = CommandDef::typed::<FileArgs, (), (), crate::media::MediaInfo, _, _>(
        "inspect",
        |ctx: TypedContext<FileArgs, (), ()>| async move {
            match crate::media::inspect_media(&ctx.args.file) {
                Ok(media) => TypedResult::ok(media),
                Err(media_error) => {
                    TypedResult::error("MEDIA_INSPECT_FAILED", media_error.to_string())
                }
            }
        },
    )
    .description("Validate MP4/H.264 media and return its descriptor")
    .mcp(mcp_options(Policy {
        mcp_name: Some("inspect_media"),
        ..LOCAL_READ
    }))
    .done();

    let poster = CommandDef::typed::<FileArgs, PosterOptions, (), PosterOutput, _, _>(
        "poster",
        |ctx: TypedContext<FileArgs, PosterOptions, ()>| async move {
            match crate::media::poster_frame(&ctx.args.file, ctx.options.output.as_deref()) {
                Ok(file) => TypedResult::ok(PosterOutput {
                    file,
                    content_type: "image/png".into(),
                }),
                Err(media_error) => {
                    TypedResult::error("MEDIA_POSTER_FAILED", media_error.to_string())
                }
            }
        },
    )
    .description("Extract a representative PNG poster from MP4/H.264 media")
    .hint("The resulting PNG can be passed directly to feedback.")
    .mcp(mcp_options(Policy {
        mcp_name: Some("extract_poster"),
        ..LOCAL_EFFECT
    }))
    .done();

    let transcribe = CommandDef::typed::<
        FileArgs,
        TranscriptOptions,
        (),
        crate::media::TranscriptResult,
        _,
        _,
    >(
        "transcribe",
        |ctx: TypedContext<FileArgs, TranscriptOptions, ()>| async move {
            match crate::media::inspect_media(&ctx.args.file) {
                Ok(_) => TypedResult::ok(crate::media::TranscriptResult {
                    status: "unavailable",
                    source: "none",
                    locale: ctx.options.locale,
                    text: String::new(),
                    segments: Vec::new(),
                    error: Some("On-device transcription is unavailable in this build; preserve the media and retry on a Nib Apple client".into()),
                }),
                Err(media_error) => {
                    TypedResult::error("MEDIA_TRANSCRIBE_FAILED", media_error.to_string())
                }
            }
        },
    )
    .description("Request an on-device transcript and preserve explicit unavailable state")
    .mcp(mcp_options(Policy {
        mcp_name: Some("transcribe_media"),
        ..LOCAL_READ
    }))
    .done();

    Cli::create("media")
        .description("Inspect and derive supported media files")
        .command("inspect", inspect)
        .command("poster", poster)
        .command("transcribe", transcribe)
}

/// Defers `HttpGenerator::from_env` to call time. Building the command tree
/// must not fail, so a misconfigured environment surfaces when `generate`
/// actually runs rather than preventing the CLI from starting at all.
struct EnvUiGenerator;

#[async_trait::async_trait]
impl nib_ui::client::Generator for EnvUiGenerator {
    async fn generate(
        &self,
        request: nib_ui::domain::GenerationRequest,
        tenant_id: Option<&str>,
        trial_network: Option<&str>,
    ) -> Result<nib_ui::domain::GenerationResponse, nib_ui::domain::UiError> {
        nib_ui::client::HttpGenerator::from_env()?
            .generate(request, tenant_id, trial_network)
            .await
    }
}

fn image_group() -> Cli {
    Cli::create("image")
        .description("Generate images through the locally configured provider")
        .command(
            "generate",
            compat_command(
                "generate",
                "Generate an image through the configured provider",
                &["generate"],
                vec![fields::field(
                    "prompt",
                    "Image generation prompt",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field("width", "Image width", FieldType::Number, true),
                    fields::field("height", "Image height", FieldType::Number, true),
                    fields::field_with_alias(
                        "out",
                        "Output PNG path",
                        FieldType::String,
                        false,
                        'o',
                    ),
                    fields::field(
                        "ref",
                        "Reference image paths",
                        FieldType::Array(Box::new(FieldType::String)),
                        false,
                    ),
                    fields::field_with_default(
                        "crop",
                        "Crop to exact dimensions",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field("timeout", "Provider timeout", FieldType::String, false),
                    fields::field_with_default(
                        "nib",
                        "Import the result into .nib",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_default(
                        "feedback",
                        "Review the generated result",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_alias(
                        "message",
                        "Review question",
                        FieldType::String,
                        false,
                        'm',
                    ),
                    fields::field_with_default(
                        "feedbackUi",
                        "Review surface",
                        FieldType::Enum(vec![
                            "native".into(),
                            "terminal".into(),
                            "web".into(),
                            "auto".into(),
                        ]),
                        json!("native"),
                    ),
                ],
                Policy {
                    open_world: true,
                    mcp_name: Some("generate_image"),
                    ..LOCAL_EFFECT
                },
            ),
        )
}

pub fn register(cli: Cli) -> Cli {
    let feedback = documented(
        command_with_policy(
            "feedback",
            "Ask a human for visual feedback in the native Nib app and wait for the final response",
            vec![fields::field(
                "file",
                "Image, .nib, or MP4/H.264 file",
                FieldType::String,
                true,
            )],
            vec![
                fields::field_with_alias(
                    "message",
                    "Question shown to the reviewer",
                    FieldType::String,
                    false,
                    'm',
                ),
                fields::field_with_alias(
                    "annotations",
                    "Image-only annotation prompt JSON",
                    FieldType::String,
                    false,
                    'a',
                ),
                fields::field_with_alias_and_default(
                    "timeout",
                    "Seconds to wait; zero waits indefinitely",
                    FieldType::Number,
                    json!(0),
                    't',
                ),
                fields::field_with_default(
                    "ui",
                    "Review surface",
                    FieldType::Enum(vec![
                        "native".into(),
                        "terminal".into(),
                        "web".into(),
                        "auto".into(),
                    ]),
                    json!("native"),
                ),
                fields::field_with_default(
                    "detach",
                    "Explicitly publish without waiting",
                    FieldType::Boolean,
                    json!(false),
                ),
            ],
            Box::new(FeedbackHandler),
            Policy {
                mcp_name: Some("feedback"),
                ..EXTERNAL_EFFECT
            },
        ),
        &[
            ("review.png", "Review an image in the native app"),
            ("demo.mp4", "Review a video and wait for the response"),
            (
                "review.png --ui web",
                "Explicitly use the browser review surface",
            ),
        ],
        Some("Attached native review is the default. Use request create when the caller explicitly wants a nonblocking request."),
    );

    #[cfg(any())]
    {
        let _request = Cli::create("request")
            .description("Create and wait for durable human requests")
            .command(
                "create",
                documented(
                    with_output_schema::<super::web_feedback::PublishedFeedback>(
                        command_with_policy(
                            "create",
                            "Publish a durable image or MP4/H.264 review and return immediately",
                            vec![fields::field(
                                "file",
                                "Image, .nib, or MP4/H.264 file",
                                FieldType::String,
                                true,
                            )],
                            vec![
                                fields::field_with_alias(
                                    "question",
                                    "Question shown to the reviewer",
                                    FieldType::String,
                                    false,
                                    'm',
                                ),
                                fields::field_with_alias(
                                    "annotations",
                                    "Image-only annotation prompt JSON",
                                    FieldType::String,
                                    false,
                                    'a',
                                ),
                            ],
                            Box::new(CreateReviewHandler),
                            Policy {
                                mcp_name: Some("create_review_request"),
                                ..EXTERNAL_EFFECT
                            },
                        ),
                    ),
                    &[(
                        "request create review.mp4 -m \"Check the transition\"",
                        "Publish a nonblocking video review",
                    )],
                    Some("Use request wait with the returned request ID."),
                ),
            )
            .command(
                "wait",
                documented(
                    with_output_schema::<Value>(command_with_policy(
                        "wait",
                        "Wait for a durable request to receive its final response",
                        vec![fields::field(
                            "requestId",
                            "Durable request ID",
                            FieldType::String,
                            true,
                        )],
                        vec![fields::field_with_alias_and_default(
                            "timeout",
                            "Seconds to wait; zero waits indefinitely",
                            FieldType::Number,
                            json!(0),
                            't',
                        )],
                        Box::new(RequestWaitHandler),
                        Policy {
                            read_only: true,
                            idempotent: true,
                            open_world: true,
                            mcp_name: Some("wait_for_request"),
                            ..EXTERNAL_EFFECT
                        },
                    )),
                    &[(
                        "request wait req_123",
                        "Resume the same durable request wait",
                    )],
                    Some(
                        "Timeouts do not create a second request; resume with the same request ID.",
                    ),
                ),
            );

        let _record = Cli::create("record")
        .description("Record the screen and manage durable recording workers")
        .command(
            "start",
            documented(
                with_output_schema::<crate::media::RecordingState>(command_with_policy(
                    "start",
                    "Start a durable macOS screen recording and return its ID",
                    vec![],
                    vec![
                        fields::field("output", "Output MP4 path", FieldType::String, false),
                        fields::field("duration", "Timed duration in seconds", FieldType::Number, false),
                        fields::field("display", "Display number", FieldType::Number, false),
                        fields::field("window", "CoreGraphics window ID", FieldType::Number, false),
                        fields::field("region", "x,y,width,height", FieldType::String, false),
                        fields::field_with_default("interactive", "Use interactive target selection", FieldType::Boolean, json!(false)),
                        fields::field_with_default("systemAudio", "Include system audio", FieldType::Boolean, json!(false)),
                        fields::field_with_default("microphone", "Include the default microphone", FieldType::Boolean, json!(false)),
                        fields::field_with_default("cursor", "Include the cursor", FieldType::Boolean, json!(true)),
                        fields::field_with_default("showClicks", "Show pointer clicks", FieldType::Boolean, json!(false)),
                    ],
                    Box::new(StartRecordingHandler),
                    Policy {
                        mcp_name: Some("start_recording"),
                        ..LOCAL_EFFECT
                    },
                )),
                &[
                    ("record start --duration 5", "Record five silent seconds"),
                    (
                        "record start --system-audio",
                        "Explicitly include system audio",
                    ),
                ],
                Some("Recording is silent unless system audio or microphone capture is explicitly requested."),
            ),
        )
        .command(
            "status",
            with_output_schema::<crate::media::RecordingState>(command_with_policy(
                "status",
                "Read one durable recording or the active recording",
                vec![fields::field(
                    "recordingId",
                    "Recording ID; omit to select the active recording",
                    FieldType::String,
                    false,
                )],
                vec![],
                Box::new(RecordingStatusHandler),
                Policy {
                    mcp_name: Some("recording_status"),
                    ..LOCAL_READ
                },
            )),
        )
        .command(
            "stop",
            documented(
                with_output_schema::<crate::media::RecordingState>(command_with_policy(
                    "stop",
                    "Idempotently stop and finalize a durable recording",
                    vec![fields::field(
                        "recordingId",
                        "Recording ID; omit to select the active recording",
                        FieldType::String,
                        false,
                    )],
                    vec![],
                    Box::new(StopRecordingHandler),
                    Policy {
                        idempotent: true,
                        mcp_name: Some("stop_recording"),
                        ..LOCAL_EFFECT
                    },
                )),
                &[("record stop rec_123", "Stop a recording")],
                Some("Stopping an already finalized recording returns its final state."),
            ),
        )
        .command(
            "wait",
            documented(
                with_output_schema::<crate::media::RecordingState>(command_with_policy(
                    "wait",
                    "Wait for a durable recording to complete or fail",
                    vec![fields::field(
                        "recordingId",
                        "Recording ID",
                        FieldType::String,
                        true,
                    )],
                    vec![fields::field_with_alias_and_default(
                        "timeout",
                        "Seconds to wait; zero waits indefinitely",
                        FieldType::Number,
                        json!(0),
                        't',
                    )],
                    Box::new(WaitRecordingHandler),
                    Policy {
                        mcp_name: Some("wait_for_recording"),
                        ..LOCAL_READ
                    },
                )),
                &[("record wait rec_123", "Wait for recording completion")],
                None,
            ),
        );

        let _media = Cli::create("media")
            .description("Inspect and derive supported media files")
            .command(
                "inspect",
                with_output_schema::<crate::media::MediaInfo>(command_with_policy(
                    "inspect",
                    "Validate MP4/H.264 media and return its descriptor",
                    vec![fields::field(
                        "file",
                        "MP4/H.264 file",
                        FieldType::String,
                        true,
                    )],
                    vec![],
                    Box::new(InspectMediaHandler),
                    Policy {
                        mcp_name: Some("inspect_media"),
                        ..LOCAL_READ
                    },
                )),
            )
            .command(
                "poster",
                documented(
                    command_with_policy(
                        "poster",
                        "Extract a representative PNG poster from MP4/H.264 media",
                        vec![fields::field(
                            "file",
                            "MP4/H.264 file",
                            FieldType::String,
                            true,
                        )],
                        vec![fields::field(
                            "output",
                            "Output PNG path",
                            FieldType::String,
                            false,
                        )],
                        Box::new(PosterMediaHandler),
                        Policy {
                            mcp_name: Some("extract_poster"),
                            ..LOCAL_EFFECT
                        },
                    ),
                    &[("media poster demo.mp4", "Extract a reviewable poster")],
                    Some("The resulting PNG can be passed directly to feedback."),
                ),
            )
            .command(
                "transcribe",
                with_output_schema::<crate::media::TranscriptResult>(command_with_policy(
                    "transcribe",
                    "Request an on-device transcript and preserve explicit unavailable state",
                    vec![fields::field(
                        "file",
                        "MP4/H.264 file",
                        FieldType::String,
                        true,
                    )],
                    vec![fields::field(
                        "locale",
                        "BCP-47 locale hint",
                        FieldType::String,
                        false,
                    )],
                    Box::new(TranscribeMediaHandler),
                    Policy {
                        mcp_name: Some("transcribe_media"),
                        ..LOCAL_READ
                    },
                )),
            );

        let _ = (_request, _record, _media);
    }

    // Typed groups are the canonical request, recording, and media contracts.
    let request = typed_request_group();
    let record = typed_record_group();
    let media = typed_media_group();
    let auth = typed_auth_group();
    let image = image_group();

    let cli = cli
        .command("feedback", feedback)
        .command(
            "review",
            command_with_policy(
                "review",
                "Open a feedback session in the full-color terminal reviewer",
                vec![fields::field(
                    "session",
                    "Session .nib path",
                    FieldType::String,
                    true,
                )],
                vec![fields::field_with_alias(
                    "message",
                    "Question shown to the reviewer",
                    FieldType::String,
                    false,
                    'm',
                )],
                Box::new(ReviewHandler),
                LOCAL_EFFECT,
            ),
        )
        .command(
            "await-submit",
            command_with_policy(
                "await-submit",
                "Wait for an annotation submission or feedback decision",
                vec![fields::field(
                    "session",
                    "Session .nib path",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field_with_alias_and_default(
                        "timeout",
                        "Seconds to wait; zero waits indefinitely",
                        FieldType::Number,
                        json!(30),
                        't',
                    ),
                    fields::field_with_default(
                        "interval",
                        "Polling interval in milliseconds",
                        FieldType::Number,
                        json!(100),
                    ),
                    fields::field_with_default(
                        "feedback",
                        "Wait for a feedback decision",
                        FieldType::Boolean,
                        json!(true),
                    ),
                ],
                Box::new(AwaitSubmitHandler),
                LOCAL_READ,
            ),
        )
        .command(
            "generate",
            nib_ui::catalog::build_generate_command(std::sync::Arc::new(EnvUiGenerator)),
        )
        .group(request)
        .group(record)
        .group(media)
        .group(auth)
        .group(image);
    register_compat(cli)
}

#[allow(dead_code)]
fn register_flat_core(cli: Cli) -> Cli {
    let cli = cli.command(
        "feedback",
        command(
            "feedback",
            "Ask a human for visual feedback and wait for structured JSON. If the command runner yields a running process or session ID, keep resuming that same process until it exits and returns the app response; do not start another feedback request or wait for a separate chat reply",
            vec![fields::field(
                "file",
                "Image or .nib file",
                FieldType::String,
                true,
            )],
            vec![
                fields::field_with_alias(
                    "message",
                    "Question shown to the reviewer",
                    FieldType::String,
                    false,
                    'm',
                ),
                fields::field_with_alias(
                    "annotations",
                    "Annotation prompt JSON",
                    FieldType::String,
                    false,
                    'a',
                ),
                fields::field_with_alias_and_default(
                    "timeout",
                    "Seconds to wait; zero waits indefinitely",
                    FieldType::Number,
                    json!(0),
                    't',
                ),
                fields::field_with_default(
                    "ui",
                    "Review surface",
                    FieldType::Enum(vec![
                        "native".into(),
                        "terminal".into(),
                        "web".into(),
                        "auto".into(),
                    ]),
                    json!("native"),
                ),
                fields::field_with_default(
                    "detach",
                    "Explicitly return after publishing; false is required unless the caller asks not to wait",
                    FieldType::Boolean,
                    json!(false),
                ),
            ],
            Box::new(FeedbackHandler),
        ),
    )
    .command(
        "review",
        command(
            "review",
            "Open a feedback session in the full-color terminal reviewer",
            vec![fields::field(
                "session",
                "Session .nib path",
                FieldType::String,
                true,
            )],
            vec![fields::field_with_alias(
                "message",
                "Question shown to the reviewer",
                FieldType::String,
                false,
                'm',
            )],
            Box::new(ReviewHandler),
        ),
    )
    .command(
        "await-submit",
        command(
            "await-submit",
            "Resume waiting for a terminal feedback response owned by another process",
            vec![fields::field(
                "session",
                "Session .nib path",
                FieldType::String,
                true,
            )],
            vec![
                fields::field_with_alias_and_default(
                    "timeout",
                    "Seconds to wait; zero waits indefinitely",
                    FieldType::Number,
                    json!(30),
                    't',
                ),
                fields::field_with_default(
                    "interval",
                    "Polling interval in milliseconds",
                    FieldType::Number,
                    json!(100),
                ),
                fields::field_with_default(
                    "feedback",
                    "Wait for a feedback decision",
                    FieldType::Boolean,
                    json!(true),
                ),
            ],
            Box::new(AwaitSubmitHandler),
        ),
    )
    .command(
        "create_review",
        command(
            "create_review",
            "Publish a durable image or MP4/H.264 review and return its request ID",
            vec![fields::field(
                "file",
                "Image, .nib, or MP4/H.264 file",
                FieldType::String,
                true,
            )],
            vec![
                fields::field(
                    "question",
                    "Question shown to the reviewer",
                    FieldType::String,
                    false,
                ),
                fields::field(
                    "annotations",
                    "Image-only annotation prompt JSON",
                    FieldType::String,
                    false,
                ),
            ],
            Box::new(CreateReviewHandler),
        ),
    )
    .command(
        "start_recording",
        command(
            "start_recording",
            "Start a durable macOS screen recording and return immediately",
            vec![],
            vec![
                fields::field("output", "Output MP4 path", FieldType::String, false),
                fields::field("duration", "Timed duration in seconds", FieldType::Number, false),
                fields::field("display", "Display number", FieldType::Number, false),
                fields::field("window", "CoreGraphics window ID", FieldType::Number, false),
                fields::field("region", "x,y,width,height", FieldType::String, false),
                fields::field_with_default(
                    "interactive",
                    "Use interactive target selection",
                    FieldType::Boolean,
                    json!(false),
                ),
                fields::field_with_default(
                    "systemAudio",
                    "Include system audio",
                    FieldType::Boolean,
                    json!(false),
                ),
                fields::field_with_default(
                    "microphone",
                    "Include the default microphone",
                    FieldType::Boolean,
                    json!(false),
                ),
                fields::field_with_default(
                    "cursor",
                    "Include the cursor",
                    FieldType::Boolean,
                    json!(true),
                ),
                fields::field_with_default(
                    "showClicks",
                    "Show pointer clicks",
                    FieldType::Boolean,
                    json!(false),
                ),
            ],
            Box::new(StartRecordingHandler),
        ),
    )
    .command(
        "recording_status",
        read_command(
            "recording_status",
            "Read one durable recording or the active recording",
            vec![fields::field(
                "recordingId",
                "Recording ID; omit to select the active recording",
                FieldType::String,
                false,
            )],
            vec![],
            Box::new(RecordingStatusHandler),
        ),
    )
    .command(
        "stop_recording",
        command(
            "stop_recording",
            "Idempotently stop and finalize a durable recording",
            vec![fields::field(
                "recordingId",
                "Recording ID; omit to select the active recording",
                FieldType::String,
                false,
            )],
            vec![],
            Box::new(StopRecordingHandler),
        ),
    )
    .command(
        "wait_recording",
        read_command(
            "wait_recording",
            "Wait for a durable recording to complete or fail",
            vec![fields::field(
                "recordingId",
                "Recording ID",
                FieldType::String,
                true,
            )],
            vec![fields::field_with_default(
                "timeout",
                "Seconds to wait; zero waits indefinitely",
                FieldType::Number,
                json!(0),
            )],
            Box::new(WaitRecordingHandler),
        ),
    )
    .command(
        "inspect_media",
        read_command(
            "inspect_media",
            "Validate MP4/H.264 media and return its descriptor",
            vec![fields::field(
                "file",
                "MP4/H.264 file",
                FieldType::String,
                true,
            )],
            vec![],
            Box::new(InspectMediaHandler),
        ),
    )
    .command(
        "poster_media",
        command(
            "poster_media",
            "Extract a representative PNG poster from MP4/H.264 media",
            vec![fields::field(
                "file",
                "MP4/H.264 file",
                FieldType::String,
                true,
            )],
            vec![fields::field(
                "output",
                "Output PNG path",
                FieldType::String,
                false,
            )],
            Box::new(PosterMediaHandler),
        ),
    )
    .command(
        "transcribe_media",
        read_command(
            "transcribe_media",
            "Request a timed on-device transcript and preserve explicit unavailable state",
            vec![fields::field(
                "file",
                "MP4/H.264 file",
                FieldType::String,
                true,
            )],
            vec![fields::field(
                "locale",
                "BCP-47 locale hint",
                FieldType::String,
                false,
            )],
            Box::new(TranscribeMediaHandler),
        ),
    );
    register_compat(cli)
}

fn register_compat(cli: Cli) -> Cli {
    let annotation = Cli::create("annotation")
        .description("Manage annotations")
        .command(
            "add",
            compat_command(
                "add",
                "Add an annotation to an image",
                &["annotation", "add"],
                vec![fields::field("file", "Image file", FieldType::String, true)],
                vec![
                    fields::field_with_alias_and_default(
                        "annotationType",
                        "Annotation type",
                        FieldType::String,
                        json!("rectangle"),
                        't',
                    ),
                    fields::field_with_alias("x", "X coordinate", FieldType::Number, true, 'x'),
                    fields::field_with_alias("y", "Y coordinate", FieldType::Number, true, 'y'),
                    fields::field_with_alias_and_default(
                        "width",
                        "Width",
                        FieldType::Number,
                        json!(100),
                        'w',
                    ),
                    fields::field_with_alias_and_default(
                        "height",
                        "Height",
                        FieldType::Number,
                        json!(50),
                        'H',
                    ),
                    fields::field_with_alias_and_default(
                        "color",
                        "Hex color",
                        FieldType::String,
                        json!("#ff0000"),
                        'c',
                    ),
                    fields::field("text", "Text content", FieldType::String, false),
                    fields::field("value", "Number value", FieldType::Number, false),
                    fields::field_with_alias(
                        "message",
                        "Message shown to the reviewer",
                        FieldType::String,
                        false,
                        'm',
                    ),
                ],
                Policy {
                    mcp_name: Some("add_annotation"),
                    ..LOCAL_EFFECT
                },
            ),
        )
        .command(
            "remove",
            compat_command(
                "remove",
                "Remove an annotation by ID",
                &["annotation", "remove"],
                vec![
                    fields::field("file", "Image file", FieldType::String, true),
                    fields::field("id", "Annotation ID", FieldType::String, true),
                ],
                vec![],
                Policy {
                    destructive: true,
                    idempotent: true,
                    mcp_name: Some("remove_annotation"),
                    ..LOCAL_EFFECT
                },
            ),
        )
        .command(
            "clear",
            compat_command(
                "clear",
                "Remove all annotations from an image",
                &["annotation", "clear"],
                vec![fields::field("file", "Image file", FieldType::String, true)],
                vec![],
                Policy {
                    destructive: true,
                    idempotent: true,
                    mcp_name: Some("clear_annotations"),
                    ..LOCAL_EFFECT
                },
            ),
        )
        .command(
            "list",
            compat_command(
                "list",
                "List annotations on an image",
                &["annotation", "list"],
                vec![fields::field("file", "Image file", FieldType::String, true)],
                vec![
                    fields::field_with_default(
                        "json",
                        "Return raw JSON",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field(
                        "since",
                        "Only annotations modified after this timestamp",
                        FieldType::Number,
                        false,
                    ),
                ],
                Policy {
                    mcp_name: Some("read_annotations"),
                    ..LOCAL_READ
                },
            ),
        );

    let tile = Cli::create("tile")
        .description("Inspect tiled captures")
        .command(
            "query",
            compat_command(
                "query",
                "Query a tiled capture by point or region",
                &["tile", "query"],
                vec![fields::field(
                    "captureDir",
                    "Tiled capture directory",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field("point", "x,y point", FieldType::String, false),
                    fields::field(
                        "region",
                        "x,y,width,height region",
                        FieldType::String,
                        false,
                    ),
                    fields::field("zoom", "Zoom level", FieldType::Number, false),
                    fields::field_with_default(
                        "includeOcr",
                        "Include OCR data",
                        FieldType::Boolean,
                        json!(false),
                    ),
                ],
                LOCAL_READ,
            ),
        )
        .command(
            "extract",
            compat_command(
                "extract",
                "Extract a region from a tiled capture",
                &["tile", "extract"],
                vec![fields::field(
                    "captureDir",
                    "Tiled capture directory",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field_with_alias(
                        "region",
                        "x,y,width,height region",
                        FieldType::String,
                        true,
                        'r',
                    ),
                    fields::field_with_alias(
                        "output",
                        "Output image",
                        FieldType::String,
                        true,
                        'o',
                    ),
                    fields::field_with_default(
                        "scale",
                        "Scale factor",
                        FieldType::Number,
                        json!(1.0),
                    ),
                ],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "list",
            compat_command(
                "list",
                "List tiles in a tiled capture",
                &["tile", "list"],
                vec![fields::field(
                    "captureDir",
                    "Tiled capture directory",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field("zoom", "Zoom level", FieldType::Number, false),
                    fields::field("details", "Show detailed bounds", FieldType::Boolean, false),
                ],
                LOCAL_READ,
            ),
        );

    cli.group(annotation)
        .group(tile)
        .command(
            "gui",
            compat_command(
                "gui",
                "Launch the native image editor",
                &["gui"],
                vec![fields::field(
                    "file",
                    "Image to open",
                    FieldType::String,
                    false,
                )],
                vec![],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "capture",
            compat_command(
                "capture",
                "Capture a screen, window, or region",
                &["capture"],
                vec![],
                vec![
                    fields::field_with_alias(
                        "output",
                        "Output file",
                        FieldType::String,
                        false,
                        'o',
                    ),
                    fields::field_with_alias_and_default(
                        "mode",
                        "Capture mode",
                        FieldType::Enum(vec!["region".into(), "screen".into(), "window".into()]),
                        json!("region"),
                        'm',
                    ),
                    fields::field_with_default(
                        "clipboard",
                        "Copy to clipboard",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_alias(
                        "edit",
                        "Open after capture",
                        FieldType::Boolean,
                        false,
                        'e',
                    ),
                    fields::field_with_alias_and_default(
                        "delay",
                        "Delay in seconds",
                        FieldType::Number,
                        json!(0),
                        'd',
                    ),
                    fields::field("app", "Application name", FieldType::String, false),
                    fields::field("title", "Window title", FieldType::String, false),
                    fields::field_with_default(
                        "tiled",
                        "Create a tile pyramid",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_default(
                        "tileSize",
                        "Tile size",
                        FieldType::Number,
                        json!(512),
                    ),
                    fields::field("zoomLevels", "Zoom levels", FieldType::Number, false),
                ],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "render",
            compat_command(
                "render",
                "Render annotations onto an image",
                &["render"],
                vec![fields::field("file", "Image file", FieldType::String, true)],
                vec![fields::field_with_alias(
                    "output",
                    "Output file",
                    FieldType::String,
                    false,
                    'o',
                )],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "import",
            compat_command(
                "import",
                "Import an image into the Nib format",
                &["import"],
                vec![fields::field(
                    "file",
                    "Image or directory",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field_with_alias(
                        "output",
                        "Output .nib file",
                        FieldType::String,
                        false,
                        'o',
                    ),
                    fields::field_with_default(
                        "migrateSidecar",
                        "Migrate JSON sidecars",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_default(
                        "deleteSidecar",
                        "Delete migrated sidecars",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_alias(
                        "recursive",
                        "Import recursively",
                        FieldType::Boolean,
                        false,
                        'r',
                    ),
                ],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "export",
            compat_command(
                "export",
                "Export a .nib file",
                &["export"],
                vec![fields::field("file", ".nib file", FieldType::String, true)],
                vec![
                    fields::field_with_alias(
                        "output",
                        "Output path",
                        FieldType::String,
                        false,
                        'o',
                    ),
                    fields::field_with_alias_and_default(
                        "exportFormat",
                        "Export format",
                        FieldType::Enum(vec!["rendered".into(), "json".into(), "qml".into()]),
                        json!("rendered"),
                        'F',
                    ),
                ],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "grid",
            compat_command(
                "grid",
                "Overlay a coordinate grid",
                &["grid"],
                vec![fields::field(
                    "file",
                    "Image or tiled capture",
                    FieldType::String,
                    true,
                )],
                vec![
                    fields::field_with_alias_and_default(
                        "spacing",
                        "Grid spacing",
                        FieldType::Number,
                        json!(100),
                        's',
                    ),
                    fields::field_with_alias(
                        "region",
                        "Focus region",
                        FieldType::String,
                        false,
                        'r',
                    ),
                    fields::field_with_alias(
                        "output",
                        "Output file",
                        FieldType::String,
                        false,
                        'o',
                    ),
                    fields::field_with_alias_and_default(
                        "color",
                        "Grid color",
                        FieldType::String,
                        json!("#80808080"),
                        'c',
                    ),
                    fields::field_with_default(
                        "majorColor",
                        "Major line color",
                        FieldType::String,
                        json!("#ff0000a0"),
                    ),
                    fields::field_with_default(
                        "majorInterval",
                        "Major line interval",
                        FieldType::Number,
                        json!(5),
                    ),
                    fields::field_with_default(
                        "json",
                        "Return metadata",
                        FieldType::Boolean,
                        json!(false),
                    ),
                ],
                LOCAL_EFFECT,
            ),
        )
        .command(
            "find-text",
            compat_command(
                "find-text",
                "Find text in an image using OCR",
                &["find-text"],
                vec![fields::field("file", "Image file", FieldType::String, true)],
                vec![
                    fields::field_with_alias(
                        "search",
                        "Text to find",
                        FieldType::String,
                        false,
                        's',
                    ),
                    fields::field_with_default(
                        "json",
                        "Return JSON",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_alias_and_default(
                        "confidence",
                        "Minimum confidence",
                        FieldType::Number,
                        json!(60),
                        'c',
                    ),
                    fields::field_with_default(
                        "highlight",
                        "Add highlight annotations",
                        FieldType::Boolean,
                        json!(false),
                    ),
                    fields::field_with_default(
                        "color",
                        "Highlight color",
                        FieldType::String,
                        json!("#ffff00"),
                    ),
                    fields::field_with_alias(
                        "region",
                        "Search region",
                        FieldType::String,
                        false,
                        'r',
                    ),
                ],
                LOCAL_READ,
            ),
        )
        .command(
            "pick-color",
            compat_command(
                "pick-color",
                "Sample a color from an image",
                &["pick-color"],
                vec![fields::field("file", "Image file", FieldType::String, true)],
                vec![
                    fields::field_with_alias("x", "X coordinate", FieldType::Number, true, 'x'),
                    fields::field_with_alias("y", "Y coordinate", FieldType::Number, true, 'y'),
                    fields::field_with_alias_and_default(
                        "radius",
                        "Sample radius",
                        FieldType::Number,
                        json!(0),
                        'r',
                    ),
                    fields::field_with_default(
                        "json",
                        "Return JSON",
                        FieldType::Boolean,
                        json!(false),
                    ),
                ],
                LOCAL_READ,
            ),
        )
        .command(
            "windows",
            compat_command(
                "windows",
                "List capturable windows",
                &["windows"],
                vec![],
                vec![
                    fields::field_with_alias(
                        "app",
                        "Application name",
                        FieldType::String,
                        false,
                        'a',
                    ),
                    fields::field_with_default(
                        "json",
                        "Return JSON",
                        FieldType::Boolean,
                        json!(false),
                    ),
                ],
                LOCAL_READ,
            ),
        )
        .command(
            "info",
            compat_command(
                "info",
                "Inspect a .nib file",
                &["info"],
                vec![fields::field("file", ".nib file", FieldType::String, true)],
                vec![fields::field_with_default(
                    "json",
                    "Return JSON",
                    FieldType::Boolean,
                    json!(false),
                )],
                LOCAL_READ,
            ),
        )
        .command(
            "validate",
            compat_command(
                "validate",
                "Validate QML or image metadata",
                &["validate"],
                vec![fields::field("file", "Input file", FieldType::String, true)],
                vec![fields::field_with_default(
                    "qmlFile",
                    "Treat input as raw QML",
                    FieldType::Boolean,
                    json!(false),
                )],
                LOCAL_READ,
            ),
        )
        .command(
            "list",
            compat_command(
                "list",
                "List recent captures",
                &["list"],
                vec![],
                vec![
                    fields::field_with_alias_and_default(
                        "limit",
                        "Maximum results",
                        FieldType::Number,
                        json!(10),
                        'n',
                    ),
                    fields::field_with_alias_and_default(
                        "sort",
                        "Sort order",
                        FieldType::Enum(vec!["date".into(), "name".into(), "size".into()]),
                        json!("date"),
                        's',
                    ),
                ],
                LOCAL_READ,
            ),
        )
        .command(
            "judge",
            compat_command(
                "judge",
                "Compare expected and actual images through the configured judge",
                &["judge"],
                vec![
                    fields::field("expected", "Expected image", FieldType::String, true),
                    fields::field("actual", "Actual image", FieldType::String, true),
                ],
                vec![
                    fields::field("timeout", "Provider timeout", FieldType::String, false),
                    fields::field_with_default(
                        "open",
                        "Open the comparison viewer",
                        FieldType::Boolean,
                        json!(false),
                    ),
                ],
                Policy {
                    open_world: true,
                    mcp_name: Some("judge_pair"),
                    ..LOCAL_EFFECT
                },
            ),
        )
        .command(
            "sessions",
            compat_command(
                "sessions",
                "List active collaboration sessions",
                &["sessions"],
                vec![],
                vec![],
                LOCAL_READ,
            ),
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn canonical_catalog_has_unique_action_first_names_and_typed_outputs() {
        let catalog = super::super::build_cli()
            .try_tool_catalog()
            .expect("the canonical command graph must not expose duplicate tool names");
        for name in [
            "create_review_request",
            "open_review_request",
            "wait_for_request",
            "start_recording",
            "recording_status",
            "stop_recording",
            "wait_for_recording",
            "inspect_media",
            "extract_poster",
            "transcribe_media",
            "auth_login",
            "auth_status",
            "auth_logout",
            "auth_pair",
            "auth_redeem",
            "add_annotation",
            "read_annotations",
            "remove_annotation",
            "clear_annotations",
            "generate_image",
            "judge_pair",
        ] {
            assert!(catalog.get(name).is_some(), "missing tool {name}");
        }

        let recording = catalog.get("start_recording").unwrap();
        assert_eq!(
            recording.output_schema.as_ref().unwrap()["title"],
            "RecordingState"
        );
        assert_eq!(
            recording.annotations.as_ref().unwrap().open_world_hint,
            Some(false)
        );

        let inspect = catalog.get("inspect_media").unwrap();
        assert_eq!(
            inspect.output_schema.as_ref().unwrap()["title"],
            "MediaInfo"
        );
        assert_eq!(
            inspect.annotations.as_ref().unwrap().read_only_hint,
            Some(true)
        );

        let clear = catalog.get("clear_annotations").unwrap();
        assert_eq!(
            clear.annotations.as_ref().unwrap().destructive_hint,
            Some(true)
        );
    }

    #[test]
    fn native_attached_feedback_is_the_catalog_default() {
        let catalog = super::super::build_cli().tool_catalog();
        let feedback = catalog.get("feedback").unwrap();
        assert_eq!(
            feedback.input_schema["properties"]["ui"]["default"],
            "native"
        );
        assert_eq!(
            feedback.input_schema["properties"]["detach"]["default"],
            false
        );
    }
}
