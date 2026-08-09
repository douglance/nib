#![cfg(target_arch = "wasm32")]

use std::cell::OnceCell;
use std::rc::Rc;
use std::sync::Arc;

use futures_util::StreamExt;
use incurs::cli::Cli;
use incurs::command::{
    CommandContext, CommandDef, CommandHandler, McpAnnotations, McpCommandOptions,
};
use incurs::output::CommandResult;
use incurs::tool::ToolCallOptions;
use incurs_codemode::{
    CodeMode, CodeModeRunOptions, DEFAULT_PAUSED_TTL_MS, DispatchRequest, ExecutionState,
    IncurConnector, SearchOutput,
};
use incurs_codemode_cloudflare::{
    CloudflareClock, DurableSqlStore, DynamicWorkerExecutor, DynamicWorkerOptions, McpHttpOptions,
    McpHttpRequest, WorkerLoader, drive_with_terminal_failure, handle_mcp_request,
    persist_terminal_failure, tenant_key,
};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::JsValue;
use worker::{
    Context, DurableObject, Env, Fetcher, Headers, Method, Request, RequestInit, Response, Result,
    State, durable_object, event,
};

#[derive(Clone)]
struct PortalClient {
    base_url: String,
    token: String,
    service: Fetcher,
}

impl PortalClient {
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> std::result::Result<Value, String> {
        let headers = Headers::new();
        headers
            .set("accept", "application/json")
            .map_err(|error| error.to_string())?;
        headers
            .set("authorization", &format!("Bearer {}", self.token))
            .map_err(|error| error.to_string())?;
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(body) = body {
            init.headers
                .set("content-type", "application/json")
                .map_err(|error| error.to_string())?;
            init.with_body(Some(JsValue::from_str(&body.to_string())));
        }
        let request = Request::new_with_init(&format!("{}{}", self.base_url, path), &init)
            .map_err(|error| error.to_string())?;
        let mut response = self
            .service
            .fetch_request(request)
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status_code();
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| error.to_string())?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "Nib global service returned HTTP {status}: {value}"
            ));
        }
        Ok(value)
    }
}

struct ListRequests(PortalClient);
struct GetRequest(PortalClient);
struct RespondRequest(PortalClient);

#[derive(incurs::Options, Deserialize)]
#[allow(dead_code)]
struct RequestOptions {
    /// Durable Nib request ID.
    request_id: String,
}

#[derive(incurs::Options, Deserialize)]
#[allow(dead_code)]
struct RespondOptions {
    /// Durable Nib request ID.
    request_id: String,
    /// Decision such as approve or reject.
    decision: String,
    /// Optional reviewer comment.
    comment: Option<String>,
}

#[async_trait::async_trait]
impl CommandHandler for ListRequests {
    async fn run(&self, _context: CommandContext) -> CommandResult {
        result(
            send_wrapper::SendWrapper::new(self.0.call(Method::Get, "/api/requests", None)).await,
        )
    }
}

#[async_trait::async_trait]
impl CommandHandler for GetRequest {
    async fn run(&self, context: CommandContext) -> CommandResult {
        let id = context.options["request_id"].as_str().unwrap_or_default();
        result(
            send_wrapper::SendWrapper::new(self.0.call(
                Method::Get,
                &format!("/api/requests/{id}"),
                None,
            ))
            .await,
        )
    }
}

#[async_trait::async_trait]
impl CommandHandler for RespondRequest {
    async fn run(&self, context: CommandContext) -> CommandResult {
        let id = context.options["request_id"].as_str().unwrap_or_default();
        let decision = context.options["decision"].as_str().unwrap_or_default();
        let comment = context.options.get("comment").and_then(Value::as_str);
        result(
            send_wrapper::SendWrapper::new(self.0.call(
                Method::Post,
                &format!("/api/requests/{id}/respond"),
                Some(json!({
                    "decision": decision,
                    "comment": comment,
                    "annotations": []
                })),
            ))
            .await,
        )
    }
}

fn result(value: std::result::Result<Value, String>) -> CommandResult {
    match value {
        Ok(data) => CommandResult::Ok { data, cta: None },
        Err(message) => CommandResult::Error {
            code: "NIB_GLOBAL_ERROR".into(),
            message,
            retryable: true,
            exit_code: None,
            cta: None,
        },
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteRequest {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionRequest {
    execution_id: String,
    seq: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionRequest {
    execution_id: String,
}

#[event(fetch)]
async fn fetch(request: Request, env: Env, _context: Context) -> Result<Response> {
    if request.path() == "/health" && request.method() == Method::Get {
        return code_mode_health(&env).await;
    }
    let preflight = request.path() == "/mcp" && request.method().as_ref() == "OPTIONS";
    let tenant = if preflight {
        "mcp-preflight".to_string()
    } else {
        match request_tenant(&request, &env) {
            Ok(tenant) => tenant,
            Err(response) => return Ok(response),
        }
    };
    env.durable_object("CODEMODE")?
        .id_from_name(&tenant)?
        .get_stub()?
        .fetch_with_request(request)
        .await
}

async fn code_mode_health(env: &Env) -> Result<Response> {
    let portal = PortalClient {
        base_url: env
            .var("NIB_PORTAL_URL")
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "https://nib-global.doug-lance.workers.dev".into()),
        token: env.secret("NIB_AUTH_TOKEN")?.to_string(),
        service: env.service("NIB_PORTAL")?,
    };
    match portal.call(Method::Get, "/api/auth/status", None).await {
        Ok(status)
            if status.get("authenticated").and_then(Value::as_bool) == Some(true)
                && status.get("kind").and_then(Value::as_str) == Some("token")
                && status.get("platform").and_then(Value::as_str)
                    == Some("cloudflare-codemode") =>
        {
            Response::from_json(&json!({
                "ok": true,
                "service": "nib-codemode-global",
                "portalAuth": "scoped-token"
            }))
        }
        Ok(_) => Response::from_json(&json!({
            "ok": false,
            "error": "The Code Mode portal credential has the wrong identity"
        }))
        .map(|response| response.with_status(503)),
        Err(_) => Response::from_json(&json!({
            "ok": false,
            "error": "The Code Mode portal credential is unavailable"
        }))
        .map(|response| response.with_status(503)),
    }
}

#[durable_object]
pub struct NibCodeMode {
    state: State,
    env: Env,
    runtime: OnceCell<Rc<CodeMode>>,
}

impl DurableObject for NibCodeMode {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            runtime: OnceCell::new(),
        }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let runtime = self.runtime()?;
        let path = request.path();
        if path == "/mcp" {
            let method = request.method().as_ref().to_string();
            let headers = request.headers().entries().collect();
            let mut allowed_origins = request
                .url()
                .ok()
                .map(|url| vec![url.origin().ascii_serialization()])
                .unwrap_or_default();
            if let Ok(origins) = self.env.var("MCP_ALLOWED_ORIGINS") {
                allowed_origins.extend(
                    origins
                        .to_string()
                        .split(',')
                        .map(str::trim)
                        .filter(|origin| !origin.is_empty())
                        .map(ToString::to_string),
                );
            }
            let options = McpHttpOptions {
                allowed_origins,
                ..McpHttpOptions::default()
            };
            let body = if method.eq_ignore_ascii_case("POST") {
                Some(read_bounded_body(&mut request, options.max_body_bytes).await?)
            } else {
                None
            };
            let input = McpHttpRequest {
                method,
                path,
                headers,
                body,
            };
            let response = handle_mcp_request(
                &WorkerCodeModeService {
                    runtime: Rc::clone(runtime),
                    state: &self.state,
                },
                input,
                &options,
            )
            .await;
            let mut output = match response.body {
                Some(body) => Response::from_json(&body)?.with_status(response.status),
                None => Response::empty()?.with_status(response.status),
            };
            for (name, value) in response.headers {
                output.headers_mut().set(&name, &value)?;
            }
            return Ok(output);
        }
        if path == "/__incurs_codemode_dispatch" {
            let input = request.json::<DispatchRequest>().await?;
            return Response::from_json(
                &runtime
                    .dispatch(input)
                    .await
                    .map_err(worker::Error::RustError)?,
            );
        }
        let response = match path.as_str() {
            "/execute" => {
                runtime
                    .execute(&request.json::<ExecuteRequest>().await?.code)
                    .await
            }
            "/approve" => {
                let input = request.json::<DecisionRequest>().await?;
                runtime.approve(&input.execution_id, input.seq).await
            }
            "/reject" => {
                let input = request.json::<DecisionRequest>().await?;
                runtime.reject(&input.execution_id, input.seq).await
            }
            "/rollback" => {
                runtime
                    .rollback(&request.json::<ExecutionRequest>().await?.execution_id)
                    .await
            }
            "/pending" => {
                return Response::from_json(
                    &runtime
                        .runtime()
                        .pending(None)
                        .await
                        .map_err(|error| worker::Error::RustError(error.to_string()))?,
                );
            }
            "/expire" => {
                return Response::from_json(
                    &runtime
                        .expire(DEFAULT_PAUSED_TTL_MS)
                        .await
                        .map_err(worker::Error::RustError)?,
                );
            }
            _ => return Response::error("Not found", 404),
        }
        .map_err(worker::Error::RustError)?;
        Response::from_json(&response)
    }
}

async fn read_bounded_body(request: &mut Request, limit: usize) -> Result<String> {
    let mut stream = request.stream()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > limit {
            return Ok("\0".repeat(limit + 1));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| worker::Error::RustError("MCP request body must be UTF-8".into()))
}

impl NibCodeMode {
    fn runtime(&self) -> Result<&Rc<CodeMode>> {
        if let Some(runtime) = self.runtime.get() {
            return Ok(runtime);
        }
        let loader = self.env.get_binding::<WorkerLoader>("LOADER")?;
        let dispatcher = self
            .env
            .durable_object("CODEMODE")?
            .id_from_string(&self.state.id().to_string())?
            .get_stub()?;
        let store = Arc::new(DurableSqlStore::new(self.state.storage().sql())?);
        let portal = PortalClient {
            base_url: self
                .env
                .var("NIB_PORTAL_URL")
                .map(|value| value.to_string())
                .unwrap_or_else(|_| "https://nib-global.doug-lance.workers.dev".into()),
            token: self.env.secret("NIB_AUTH_TOKEN")?.to_string(),
            service: self.env.service("NIB_PORTAL")?,
        };
        let read_only = McpCommandOptions {
            annotations: Some(McpAnnotations {
                read_only_hint: Some(true),
                idempotent_hint: Some(true),
                open_world_hint: Some(false),
                ..McpAnnotations::default()
            }),
            ..McpCommandOptions::default()
        };
        let catalog = Cli::create("nib")
            .command(
                "request_list",
                CommandDef::build("request_list", ListRequests(portal.clone()))
                    .description("List globally available Nib requests.")
                    .mcp(read_only.clone())
                    .done(),
            )
            .command(
                "request_get",
                CommandDef::build("request_get", GetRequest(portal.clone()))
                    .description("Read one global Nib request.")
                    .options::<RequestOptions>()
                    .mcp(read_only)
                    .done(),
            )
            .command(
                "request_respond",
                CommandDef::build("request_respond", RespondRequest(portal))
                    .description("Submit a decision for a global Nib request after approval.")
                    .options::<RespondOptions>()
                    .done(),
            )
            .tool_catalog();
        self.runtime
            .set(Rc::new(CodeMode::with_clock_and_artifact_store(
                store.clone(),
                store,
                DynamicWorkerExecutor::new(loader, dispatcher, DynamicWorkerOptions::default()),
                vec![Arc::new(
                    IncurConnector::new(catalog).with_call_options(ToolCallOptions::isolated()),
                )],
                CloudflareClock,
            )))
            .map_err(|_| {
                worker::Error::RustError("Code Mode runtime already initialized".into())
            })?;
        Ok(self.runtime.get().unwrap())
    }
}

struct WorkerCodeModeService<'a> {
    runtime: Rc<CodeMode>,
    state: &'a State,
}

#[async_trait::async_trait(?Send)]
impl incurs_codemode_cloudflare::WorkerCodeModeService for WorkerCodeModeService<'_> {
    async fn search(&self, query: String) -> std::result::Result<SearchOutput, String> {
        self.runtime.search(&query).await
    }
    async fn execute(
        &self,
        code: String,
        options: CodeModeRunOptions,
    ) -> std::result::Result<ExecutionState, String> {
        let state = self.runtime.start(&code).await?;
        let execution_id = state.id.clone();
        let runtime = Rc::clone(&self.runtime);
        self.state.wait_until(async move {
            let _ = drive_with_terminal_failure(&runtime, &execution_id, options, &CloudflareClock)
                .await;
        });
        Ok(state)
    }
    async fn execution(&self, execution_id: String) -> std::result::Result<ExecutionState, String> {
        self.runtime.execution_snapshot(&execution_id).await
    }
    async fn artifact(
        &self,
        execution_id: String,
        artifact_id: String,
    ) -> std::result::Result<Value, String> {
        self.runtime.artifact(&execution_id, &artifact_id).await
    }
    async fn approve(
        &self,
        execution_id: String,
        seq: u64,
        options: CodeModeRunOptions,
    ) -> std::result::Result<ExecutionState, String> {
        if let Err(error) = self.runtime.approve_with(&execution_id, seq, options).await {
            let _ =
                persist_terminal_failure(&self.runtime, &execution_id, &error, &CloudflareClock)
                    .await;
            return Err(error);
        }
        self.runtime.execution_snapshot(&execution_id).await
    }
    async fn reject(
        &self,
        execution_id: String,
        seq: u64,
    ) -> std::result::Result<ExecutionState, String> {
        self.runtime.reject(&execution_id, seq).await?;
        self.runtime.execution_snapshot(&execution_id).await
    }
    async fn cancel(&self, execution_id: String) -> std::result::Result<ExecutionState, String> {
        self.runtime.cancel(&execution_id).await?;
        self.runtime.execution_snapshot(&execution_id).await
    }
}

fn request_tenant(request: &Request, env: &Env) -> std::result::Result<String, Response> {
    let local = request
        .url()
        .ok()
        .and_then(|url| url.host_str().map(ToString::to_string))
        .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"));
    let configured = env
        .secret("MCP_AUTH_TOKEN")
        .ok()
        .map(|value| value.to_string());
    let Some(expected) = configured else {
        if local {
            return Ok("local-default".into());
        }
        return Err(Response::error(
            "Remote access is disabled until MCP_AUTH_TOKEN is configured",
            503,
        )
        .unwrap());
    };
    let supplied = request
        .headers()
        .get("authorization")
        .ok()
        .flatten()
        .and_then(|value| {
            value
                .split_once(' ')
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                .map(|(_, token)| token.to_string())
        });
    if !supplied.is_some_and(|token| constant_time_eq(token.as_bytes(), expected.as_bytes())) {
        let mut response = Response::error("Unauthorized", 401).unwrap();
        let _ = response
            .headers_mut()
            .set("www-authenticate", "Bearer realm=\"nib-codemode\"");
        return Err(response);
    }
    // Version the tenant namespace when catalog policy semantics change. Durable
    // Object isolates can retain an initialized CodeMode catalog across a Worker
    // deployment, so a namespace revision makes the corrected policy immediate.
    Ok(format!("tenant-v2-{}", tenant_key(&expected)))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        difference |= usize::from(*left.get(index).unwrap_or(&0) ^ *right.get(index).unwrap_or(&0));
    }
    difference == 0
}
