use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use incurs::command::{
    CommandContext, CommandDef, CommandHandler, Example, McpAnnotations, McpCommandOptions,
    McpResultContent,
};
use incurs::output::CommandResult;
use incurs::schema::{FieldMeta, FieldType};

use crate::client::Generator;
use crate::domain::{
    GenerationRequest, GenerationResponse, ImageFormat, Quality, ReferenceImage, Resolution,
    UiError,
};

struct GenerateHandler {
    generator: Arc<dyn Generator>,
}

#[async_trait]
impl CommandHandler for GenerateHandler {
    async fn run(&self, context: CommandContext) -> CommandResult {
        match run_generate(&self.generator, &context).await {
            Ok(response) => CommandResult::Ok {
                data: serde_json::to_value(response).expect("generation response serializes"),
                cta: None,
                exit_code: None,
            },
            Err(error) => CommandResult::Error {
                code: error.code().to_string(),
                message: error.to_string(),
                retryable: matches!(error, UiError::Service(_)),
                exit_code: Some(1),
                cta: None,
            },
        }
    }
}

/// Builds the hosted UI-generation command for registration into nib's command
/// tree. This crate no longer owns a CLI of its own; nib is the only binary.
pub fn build_generate_command(generator: Arc<dyn Generator>) -> CommandDef {
    let mut generate = CommandDef::build("generate", GenerateHandler { generator })
        .description("Generate one user-interface image from a text brief and optional references. Use when an AI agent can describe a UI but cannot create the image itself")
        .examples(vec![Example {
            command: "\"A calm billing settings page\" --quality fast --aspect 16:9 --resolution 1K".to_string(),
            description: Some("Generate the free Fast 1K UI visualization".to_string()),
        }])
        .mcp(McpCommandOptions {
            name: Some("generate_ui".to_string()),
            description: Some(
                "Generate one user-interface image from a text brief and optional references. Use when an AI agent can describe a UI but cannot create the image itself. Returns one PNG or JPEG image."
                    .to_string(),
            ),
            instructions: Some(
                "Authenticate the user through Cloudflare Access and pass the user-scoped token as NIB_ACCESS_TOKEN. Provide a precise UI brief and up to three PNG, JPEG, or WebP references as data URIs. Fast 1K is the default and is eligible for the one-image free trial. Return the image directly to the user."
                    .to_string(),
            ),
            annotations: Some(McpAnnotations {
                title: Some("Generate a UI image".to_string()),
                read_only_hint: Some(false),
                destructive_hint: Some(false),
                idempotent_hint: Some(false),
                open_world_hint: Some(true),
            }),
            result_content: vec![McpResultContent::Image {
                data_pointer: "/image/data".to_string(),
                mime_type_pointer: "/image/mime_type".to_string(),
            }],
            ..Default::default()
        })
        .done();
    generate.args_fields = vec![field(
        "prompt",
        "prompt",
        FieldType::String,
        false,
        None,
        "The UI brief. Required unless --resume is provided.",
    )];
    generate.options_fields = vec![
        field(
            "ref",
            "ref",
            FieldType::Array(Box::new(FieldType::String)),
            false,
            None,
            "Reference image path for CLI, or data URI for MCP. Repeat up to three times.",
        ),
        field(
            "quality",
            "quality",
            FieldType::Enum(vec!["fast".into(), "standard".into(), "pro".into()]),
            false,
            Some(serde_json::json!("fast")),
            "Generation quality preset. Fast is eligible for the free trial.",
        ),
        field(
            "aspect",
            "aspect",
            FieldType::Enum(
                [
                    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
                ]
                .into_iter()
                .map(String::from)
                .collect(),
            ),
            false,
            Some(serde_json::json!("16:9")),
            "Native Gemini aspect ratio.",
        ),
        field(
            "resolution",
            "resolution",
            FieldType::Enum(vec!["1K".into(), "2K".into(), "4K".into()]),
            false,
            Some(serde_json::json!("1K")),
            "Native Gemini output resolution.",
        ),
        field(
            "format",
            "image-format",
            FieldType::Enum(vec!["png".into(), "jpg".into()]),
            false,
            Some(serde_json::json!("png")),
            "Saved image format.",
        ),
        field(
            "output",
            "output",
            FieldType::String,
            false,
            None,
            "Local output path. CLI only.",
        ),
        field(
            "background",
            "background",
            FieldType::Boolean,
            false,
            Some(serde_json::json!(false)),
            "Return a queued job instead of waiting for the image.",
        ),
        field(
            "resume",
            "resume",
            FieldType::String,
            false,
            None,
            "Resume or inspect a background job.",
        ),
    ];
    generate.output_schema = Some(
        serde_json::to_value(schemars::schema_for!(GenerationResponse))
            .expect("output schema serializes"),
    );

    generate
}

fn field(
    name: &'static str,
    cli_name: &str,
    field_type: FieldType,
    required: bool,
    default: Option<serde_json::Value>,
    description: &'static str,
) -> FieldMeta {
    FieldMeta {
        name,
        cli_name: cli_name.to_string(),
        description: Some(description),
        field_type,
        required,
        default,
        alias: None,
        deprecated: false,
        env_name: None,
    }
}

async fn run_generate(
    generator: &Arc<dyn Generator>,
    context: &CommandContext,
) -> Result<GenerationResponse, UiError> {
    let prompt = context
        .args
        .get("prompt")
        .and_then(serde_json::Value::as_str);
    let resume = string_option(&context.options, "resume");
    let remote_request = context.request.is_some();
    let reference_values = context
        .options
        .get("ref")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut references = Vec::with_capacity(reference_values.len());
    for value in reference_values {
        let value = value.as_str().ok_or(UiError::InvalidReferenceData)?;
        references.push(load_reference(value, remote_request).await?);
    }
    let quality = option(&context.options, "quality", "fast").parse::<Quality>()?;
    let resolution = option(&context.options, "resolution", "1K").parse::<Resolution>()?;
    let format = option(&context.options, "format", "png").parse::<ImageFormat>()?;
    let request = GenerationRequest {
        prompt: prompt.map(str::to_string),
        resume_job_id: resume,
        references,
        quality,
        aspect: option(&context.options, "aspect", "16:9").to_string(),
        resolution,
        format,
        background: context
            .options
            .get("background")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    };
    request.validate()?;
    let tenant_id = context
        .request
        .as_ref()
        .and_then(|request| request.headers.get("x-nib-tenant"))
        .map(String::as_str);
    let trial_network = context
        .request
        .as_ref()
        .and_then(|request| request.headers.get("x-nib-trial-network"))
        .map(String::as_str);
    let mut response = generator
        .generate(request, tenant_id, trial_network)
        .await?;
    if !remote_request && let Some(image) = response.image.take() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.data)
            .map_err(|_| UiError::InvalidReferenceData)?;
        let path = string_option(&context.options, "output")
            .unwrap_or_else(|| default_output_path(response.format));
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|source| UiError::OutputWrite {
                path: path.clone(),
                source,
            })?;
        response.output_path = Some(path);
    }
    Ok(response)
}

fn option<'a>(options: &'a serde_json::Value, name: &str, default: &'a str) -> &'a str {
    options
        .get(name)
        .and_then(serde_json::Value::as_str)
        .unwrap_or(default)
}

fn string_option(options: &serde_json::Value, name: &str) -> Option<String> {
    options
        .get(name)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn load_reference(value: &str, agent: bool) -> Result<ReferenceImage, UiError> {
    if agent {
        let (metadata, data) = value.split_once(',').ok_or(UiError::InvalidReferenceData)?;
        let mime_type = metadata
            .strip_prefix("data:")
            .and_then(|value| value.strip_suffix(";base64"))
            .ok_or(UiError::InvalidReferenceData)?;
        return Ok(ReferenceImage {
            name: "reference".to_string(),
            mime_type: mime_type.to_string(),
            data: data.to_string(),
        });
    }

    let path = Path::new(value);
    let mime_type = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(UiError::ReferenceExtension(value.to_string())),
    };
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|source| UiError::ReferenceRead {
            path: value.to_string(),
            source,
        })?;
    Ok(ReferenceImage {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("reference")
            .to_string(),
        mime_type: mime_type.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn default_output_path(format: ImageFormat) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let extension = match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpg => "jpg",
    };
    format!("nib-ui-{timestamp}.{extension}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{GenerationResponse, ImagePayload};

    struct FakeGenerator;

    #[async_trait]
    impl Generator for FakeGenerator {
        async fn generate(
            &self,
            request: GenerationRequest,
            _tenant_id: Option<&str>,
            _trial_network: Option<&str>,
        ) -> Result<GenerationResponse, UiError> {
            Ok(GenerationResponse {
                job_id: "job_test".to_string(),
                status: "succeeded".to_string(),
                model: request.quality.model_id().to_string(),
                quality: request.quality,
                aspect: request.aspect,
                resolution: request.resolution,
                format: request.format,
                usage_cents: request.quality.price_cents(request.resolution)?,
                artifact_url: Some("https://example.test/artifact".to_string()),
                image: Some(ImagePayload {
                    data: "iVBORw0KGgo=".to_string(),
                    mime_type: "image/png".to_string(),
                }),
                output_path: None,
            })
        }
    }

    #[test]
    fn generate_is_exposed_to_mcp_as_generate_ui() {
        // Registered into a throwaway CLI so the assertions run against the
        // real tool catalog. Deliberately does not assert the catalog size:
        // nib registers many commands alongside this one.
        let definitions = incurs::cli::Cli::create("nib")
            .command("generate", build_generate_command(Arc::new(FakeGenerator)))
            .tool_catalog()
            .definitions();
        let generate = definitions
            .iter()
            .find(|definition| definition.name == "generate_ui")
            .expect("generate is exposed as generate_ui");
        assert_eq!(generate.result_content.len(), 1);
        assert_eq!(
            generate.input_schema.pointer("/properties/quality/default"),
            Some(&serde_json::json!("fast")),
        );
        assert_eq!(
            generate
                .input_schema
                .pointer("/properties/resolution/default"),
            Some(&serde_json::json!("1K")),
        );
    }
}
