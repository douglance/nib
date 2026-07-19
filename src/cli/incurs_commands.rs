//! Incurs registrations for the terminal feedback slice.
//!
//! The current `nib` binary still parses through clap during the staged
//! migration; both adapters construct the same request types and call the same
//! command implementations.

use super::{fields, AwaitSubmitArgs, FeedbackArgs, FeedbackUi, ReviewArgs};
use async_trait::async_trait;
use incurs::{
    cli::Cli,
    command::{CommandContext, CommandDef, CommandHandler},
    output::CommandResult,
    schema::FieldType,
};
use serde_json::{json, Value};

struct FeedbackHandler;
struct ReviewHandler;
struct AwaitSubmitHandler;

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
    match value.and_then(Value::as_str).unwrap_or("gui") {
        "gui" => Ok(FeedbackUi::Gui),
        "terminal" => Ok(FeedbackUi::Terminal),
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
                .unwrap_or(60),
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
        match super::commands::run_feedback(&args).await {
            Ok(()) => CommandResult::Ok {
                data: json!({"completed": true}),
                cta: None,
            },
            Err(err) => error(err),
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
            },
            Err(err) => error(err),
        }
    }
}

fn command(
    name: &str,
    description: &str,
    args_fields: Vec<incurs::schema::FieldMeta>,
    options_fields: Vec<incurs::schema::FieldMeta>,
    handler: Box<dyn CommandHandler>,
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
        handler,
        middleware: vec![],
        output_schema: None,
    }
}

pub fn register(cli: Cli) -> Cli {
    cli.command(
        "feedback",
        command(
            "feedback",
            "Ask a human for visual feedback and wait for structured JSON",
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
                    json!(60),
                    't',
                ),
                fields::field_with_default(
                    "ui",
                    "Review surface",
                    FieldType::Enum(vec!["gui".into(), "terminal".into(), "auto".into()]),
                    json!("gui"),
                ),
                fields::field_with_default(
                    "detach",
                    "Return after opening the review",
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
            "Wait for a detached feedback response",
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
}
