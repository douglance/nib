use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    process::Command,
    thread,
    time::{Duration, Instant},
};

const KEYCHAIN_SERVICE: &str = "com.douglance.nib.auth";
const DEFAULT_PORTAL_URL: &str = "https://app.nibtool.com";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_CLIENT_ID: &str = "nib-cli";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
    pub kind: String,
    pub subject: String,
    pub name: String,
    pub platform: String,
    pub scopes: Vec<String>,
    pub portal: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthLogout {
    pub revoked: bool,
    pub cleared: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthExpertToken {
    pub id: String,
    pub token: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthExpertTokenSummary {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthExpertTokenList {
    pub tokens: Vec<AuthExpertTokenSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokenRevocation {
    pub id: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialSource {
    Environment,
    Keychain,
}

impl CredentialSource {
    fn label(self) -> &'static str {
        match self {
            Self::Environment => "environment",
            Self::Keychain => "keychain",
        }
    }
}

struct Credential {
    token: String,
    source: CredentialSource,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
}

pub fn login(portal: &str, name: Option<&str>) -> Result<AuthStatus, String> {
    let portal = normalize_portal(portal);
    if let Some(credential) = current_credential(&portal) {
        match status_with_token(&portal, &credential.token, credential.source) {
            Ok(status) => return Ok(status),
            Err(_) if credential.source == CredentialSource::Keychain => {
                delete_keychain_token(&portal);
            }
            Err(error) => return Err(error),
        }
    }

    let device = request_device_authorization(&portal, name.unwrap_or("Nib CLI"))?;
    eprintln!("Open {}", device.verification_uri_complete);
    eprintln!("Confirm code {}", device.user_code);
    open_browser(&device.verification_uri_complete);
    let token = poll_device_token(&portal, &device)?;
    store_keychain_token(&portal, &token)?;
    status_with_token(&portal, &token, CredentialSource::Keychain)
}

pub fn status(portal: &str) -> Result<AuthStatus, String> {
    let portal = normalize_portal(portal);
    let credential = resolved_credential(&portal)?;
    status_with_token(&portal, &credential.token, credential.source)
}

pub fn logout(portal: &str) -> Result<AuthLogout, String> {
    let portal = normalize_portal(portal);
    let credential =
        current_credential(&portal).ok_or_else(|| "Nib is not authenticated".to_string())?;
    if credential.token.starts_with("nib_pat_") {
        return Err("Expert tokens must be revoked with `nib auth token revoke <id>`".into());
    }
    let agent = agent();
    let request = agent
        .post(&format!("{portal}/api/auth/sign-out"))
        .set("authorization", &format!("Bearer {}", credential.token));
    let cleared = if credential.source == CredentialSource::Environment {
        false
    } else {
        delete_keychain_token(&portal);
        true
    };
    call_json(request).map_err(|error| {
        if cleared {
            format!("The local Nib credential was cleared, but remote revocation failed: {error}")
        } else {
            error
        }
    })?;
    Ok(AuthLogout {
        revoked: true,
        cleared,
        source: credential.source.label().into(),
    })
}

pub fn create_expert_token(
    portal: &str,
    name: &str,
    scopes: &[String],
    expires_in_days: u16,
) -> Result<AuthExpertToken, String> {
    let portal = normalize_portal(portal);
    let credential = resolved_credential(&portal)?;
    let response = agent()
        .post(&format!("{portal}/api/account/tokens"))
        .set("authorization", &format!("Bearer {}", credential.token))
        .set("content-type", "application/json")
        .send_json(json!({
            "name": name,
            "scopes": scopes,
            "expiresInDays": expires_in_days
        }))
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    serde_json::from_value(response).map_err(|error| format!("Invalid expert token response: {error}"))
}

pub fn list_expert_tokens(portal: &str) -> Result<AuthExpertTokenList, String> {
    let portal = normalize_portal(portal);
    let credential = resolved_credential(&portal)?;
    let response = call_json(
        agent()
            .get(&format!("{portal}/api/account/tokens"))
            .set("authorization", &format!("Bearer {}", credential.token)),
    )?;
    serde_json::from_value(response).map_err(|error| format!("Invalid expert token list: {error}"))
}

pub fn revoke_expert_token(
    portal: &str,
    id: &str,
) -> Result<AuthTokenRevocation, String> {
    let portal = normalize_portal(portal);
    let credential = resolved_credential(&portal)?;
    agent()
        .delete(&format!("{portal}/api/account/tokens/{id}"))
        .set("authorization", &format!("Bearer {}", credential.token))
        .call()
        .map_err(http_error)?;
    Ok(AuthTokenRevocation {
        id: id.into(),
        revoked: true,
    })
}

pub fn resolved_access_token(portal: &str) -> Result<String, String> {
    Ok(resolved_credential(&normalize_portal(portal))?.token)
}

pub fn default_portal() -> String {
    std::env::var("NIB_PORTAL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PORTAL_URL.to_string())
}

fn resolved_credential(portal: &str) -> Result<Credential, String> {
    current_credential(portal).ok_or_else(|| {
        "Nib is not authenticated. Run `nib auth login` or set NIB_AUTH_TOKEN for automation."
            .to_string()
    })
}

fn status_with_token(
    portal: &str,
    token: &str,
    source: CredentialSource,
) -> Result<AuthStatus, String> {
    let response = agent()
        .get(&format!("{portal}/api/account"))
        .set("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    Ok(AuthStatus {
        authenticated: true,
        kind: string_field(&response, "credentialKind"),
        subject: string_field(&response, "userId"),
        name: string_field(&response, "email"),
        platform: "cli".into(),
        scopes: response
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| vec!["reviews:read".into(), "reviews:write".into()]),
        portal: portal.into(),
        source: source.label().into(),
    })
}

fn request_device_authorization(portal: &str, name: &str) -> Result<DeviceAuthorization, String> {
    let response = agent()
        .post(&format!("{portal}/api/auth/device/code"))
        .set("content-type", "application/json")
        .send_json(json!({
            "client_id": DEVICE_CLIENT_ID,
            "scope": "requests:read requests:write",
            "name": name
        }))
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    serde_json::from_value(response)
        .map_err(|error| format!("Nib returned an invalid device authorization: {error}"))
}

fn poll_device_token(portal: &str, device: &DeviceAuthorization) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(device.expires_in);
    let mut interval = Duration::from_secs(device.interval.max(1));
    while Instant::now() < deadline {
        thread::sleep(interval);
        let response = agent()
            .post(&format!("{portal}/api/auth/device/token"))
            .set("content-type", "application/json")
            .send_json(json!({
                "grant_type": DEVICE_GRANT,
                "device_code": device.device_code,
                "client_id": DEVICE_CLIENT_ID
            }));
        match response {
            Ok(response) => {
                let payload = response
                    .into_json::<Value>()
                    .map_err(|error| error.to_string())?;
                return payload
                    .get("access_token")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        "Nib device authorization did not return an access token".into()
                    });
            }
            Err(ureq::Error::Status(_, response)) => {
                let payload = response.into_json::<Value>().unwrap_or_default();
                match payload.get("error").and_then(Value::as_str) {
                    Some("authorization_pending") => continue,
                    Some("slow_down") => {
                        interval += Duration::from_secs(5);
                        continue;
                    }
                    Some("access_denied") => {
                        return Err("Nib device authorization was denied".into())
                    }
                    Some("expired_token") => return Err("Nib device authorization expired".into()),
                    _ => return Err(format!("Nib device authorization failed: {payload}")),
                }
            }
            Err(error) => return Err(http_error(error)),
        }
    }
    Err("Nib device authorization expired".into())
}

#[cfg(target_os = "macos")]
fn open_browser(url: &str) {
    let _ = Command::new("/usr/bin/open").arg(url).status();
}

#[cfg(not(target_os = "macos"))]
fn open_browser(_url: &str) {}

fn current_credential(portal: &str) -> Option<Credential> {
    if let Ok(token) = std::env::var("NIB_AUTH_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(Credential {
                token,
                source: CredentialSource::Environment,
            });
        }
    }
    if let Some(token) = keychain_token(portal) {
        return Some(Credential {
            token,
            source: CredentialSource::Keychain,
        });
    }
    None
}

fn keychain_account(portal: &str) -> String {
    portal
        .trim()
        .trim_end_matches('/')
        .strip_prefix("https://")
        .or_else(|| portal.trim().trim_end_matches('/').strip_prefix("http://"))
        .unwrap_or(portal)
        .to_ascii_lowercase()
}

#[cfg(target_os = "macos")]
fn keychain_token(portal: &str) -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &keychain_account(portal),
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(not(target_os = "macos"))]
fn keychain_token(_portal: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn store_keychain_token(portal: &str, token: &str) -> Result<(), String> {
    let result = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &keychain_account(portal),
            "-w",
            token,
        ])
        .output()
        .map_err(|error| format!("Could not open Keychain: {error}"))?;
    if result.status.success() {
        Ok(())
    } else {
        Err("Could not store the Nib credential in Keychain".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn store_keychain_token(_portal: &str, _token: &str) -> Result<(), String> {
    Err(
        "Secure credential persistence is not available on this platform; use NIB_AUTH_TOKEN"
            .into(),
    )
}

#[cfg(target_os = "macos")]
fn delete_keychain_token(portal: &str) -> bool {
    Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &keychain_account(portal),
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_token(_portal: &str) -> bool {
    false
}

fn normalize_portal(portal: &str) -> String {
    portal.trim().trim_end_matches('/').to_string()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_millis(1500))
        .timeout_read(std::time::Duration::from_secs(10))
        .timeout_write(std::time::Duration::from_secs(10))
        .build()
}

fn call_json(request: ureq::Request) -> Result<Value, String> {
    request
        .call()
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())
}

fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            if body.is_empty() {
                format!("Nib auth failed with HTTP {status}")
            } else {
                format!("Nib auth failed with HTTP {status}: {body}")
            }
        }
        ureq::Error::Transport(error) => format!("Nib auth service is unavailable: {error}"),
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_accounts_are_portal_specific() {
        assert_eq!(
            keychain_account("https://nib-global.example.test/"),
            "nib-global.example.test"
        );
        assert_eq!(keychain_account("http://127.0.0.1:8787"), "127.0.0.1:8787");
    }

    #[test]
    fn cloud_login_defaults_to_the_nib_app_domain() {
        assert_eq!(DEFAULT_PORTAL_URL, "https://app.nibtool.com");
    }

    #[test]
    fn parses_standard_device_authorization_responses() {
        let device: DeviceAuthorization = serde_json::from_value(json!({
            "device_code": "device-secret",
            "user_code": "ABCD-1234",
            "verification_uri_complete": "https://app.nibtool.com/device?user_code=ABCD1234",
            "expires_in": 600,
            "interval": 5
        }))
        .unwrap();
        assert_eq!(device.user_code, "ABCD-1234");
        assert_eq!(device.expires_in, 600);
    }
}
