use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Command;

const KEYCHAIN_SERVICE: &str = "com.douglance.nib.auth";
const LEGACY_DEFAULTS_DOMAIN: &str = "com.douglance.nib.macos";
const LEGACY_DEFAULTS_KEY: &str = "nib.authToken";
const DEFAULT_PORTAL_URL: &str = "https://nib-global.doug-lance.workers.dev";

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
pub struct AuthPairing {
    pub code: String,
    pub url: String,
    pub expires_at: String,
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
pub struct AuthIssuedCredential {
    pub token: String,
    pub token_type: String,
    pub name: String,
    pub platform: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialSource {
    Environment,
    Keychain,
    LegacyDefaults,
}

impl CredentialSource {
    fn label(self) -> &'static str {
        match self {
            Self::Environment => "environment",
            Self::Keychain => "keychain",
            Self::LegacyDefaults => "legacy-defaults",
        }
    }
}

struct Credential {
    token: String,
    source: CredentialSource,
}

pub fn login(portal: &str, name: Option<&str>) -> Result<AuthStatus, String> {
    let portal = normalize_portal(portal);
    if let Some(mut credential) = current_credential(&portal, true) {
        if credential.source != CredentialSource::LegacyDefaults {
            match status_with_token(&portal, &credential.token, credential.source) {
                Ok(status) if status.kind != "bootstrap" => return Ok(status),
                Ok(_) => {}
                Err(_) if credential.source == CredentialSource::Keychain => {
                    delete_keychain_token(&portal);
                    credential = legacy_token()
                        .map(|token| Credential {
                            token,
                            source: CredentialSource::LegacyDefaults,
                        })
                        .ok_or_else(|| {
                            "The stored Nib credential was invalid and has been removed. Set NIB_AUTH_TOKEN once or redeem a pairing code, then run `nib auth login` again.".to_string()
                        })?;
                }
                Err(error) => return Err(error),
            }
        }
        let issued = exchange(&portal, &credential.token, name.unwrap_or("Nib CLI"), "cli")?;
        let token = issued
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| "Nib auth exchange did not return a token".to_string())?;
        store_keychain_token(&portal, token)?;
        if credential.source == CredentialSource::LegacyDefaults {
            delete_legacy_token();
        }
        return status_with_token(&portal, token, CredentialSource::Keychain);
    }
    Err("Nib is not enrolled. Set NIB_AUTH_TOKEN once, then run `nib auth login`, or redeem a pairing code with `nib auth redeem`.".into())
}

pub fn status(portal: &str) -> Result<AuthStatus, String> {
    let portal = normalize_portal(portal);
    let credential = resolved_credential(&portal)?;
    status_with_token(&portal, &credential.token, credential.source)
}

pub fn logout(portal: &str) -> Result<AuthLogout, String> {
    let portal = normalize_portal(portal);
    let credential =
        current_credential(&portal, false).ok_or_else(|| "Nib is not authenticated".to_string())?;
    let agent = agent();
    let request = agent
        .post(&format!("{portal}/api/auth/logout"))
        .set("authorization", &format!("Bearer {}", credential.token));
    let cleared = if credential.source == CredentialSource::Environment {
        false
    } else {
        delete_keychain_token(&portal);
        delete_legacy_token();
        true
    };
    let response = call_json(request).map_err(|error| {
        if cleared {
            format!("The local Nib credential was cleared, but remote revocation failed: {error}")
        } else {
            error
        }
    })?;
    let revoked = response
        .get("revoked")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(AuthLogout {
        revoked,
        cleared,
        source: credential.source.label().into(),
    })
}

pub fn pair(portal: &str) -> Result<AuthPairing, String> {
    let portal = normalize_portal(portal);
    let credential = resolved_credential(&portal)?;
    let response = call_json(
        agent()
            .post(&format!("{portal}/api/auth/pairings"))
            .set("authorization", &format!("Bearer {}", credential.token)),
    )?;
    serde_json::from_value(response).map_err(|error| format!("Invalid pairing response: {error}"))
}

pub fn redeem(
    portal: &str,
    code: &str,
    name: Option<&str>,
    platform: Option<&str>,
) -> Result<AuthStatus, String> {
    let portal = normalize_portal(portal);
    let issued = agent()
        .post(&format!("{portal}/api/auth/pairings/redeem"))
        .set("content-type", "application/json")
        .send_json(json!({
            "code": code,
            "name": name.unwrap_or("Nib CLI"),
            "platform": platform.unwrap_or("cli")
        }))
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    let token = issued
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Nib pairing response did not return a token".to_string())?;
    store_keychain_token(&portal, token)?;
    status_with_token(&portal, token, CredentialSource::Keychain)
}

pub fn issue_service_token(
    portal: &str,
    name: Option<&str>,
    platform: Option<&str>,
) -> Result<AuthIssuedCredential, String> {
    let portal = normalize_portal(portal);
    let pairing = pair(&portal)?;
    let issued = agent()
        .post(&format!("{portal}/api/auth/pairings/redeem"))
        .set("content-type", "application/json")
        .send_json(json!({
            "code": pairing.code,
            "name": name.unwrap_or("Nib Code Mode"),
            "platform": platform.unwrap_or("cloudflare-codemode")
        }))
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    serde_json::from_value(issued).map_err(|error| format!("Invalid issued credential: {error}"))
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
    let credential = current_credential(portal, true).ok_or_else(|| {
        "Nib is not authenticated. Run `nib auth login` or set NIB_AUTH_TOKEN for automation."
            .to_string()
    })?;
    if credential.source != CredentialSource::LegacyDefaults {
        return Ok(credential);
    }
    let issued = exchange(portal, &credential.token, "Nib CLI", "cli")?;
    let token = issued
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Nib auth migration did not return a token".to_string())?
        .to_string();
    store_keychain_token(portal, &token)?;
    delete_legacy_token();
    Ok(Credential {
        token,
        source: CredentialSource::Keychain,
    })
}

fn exchange(portal: &str, bootstrap: &str, name: &str, platform: &str) -> Result<Value, String> {
    let response = agent()
        .post(&format!("{portal}/api/auth/exchange"))
        .set("authorization", &format!("Bearer {bootstrap}"))
        .set("content-type", "application/json")
        .send_json(json!({ "name": name, "platform": platform }))
        .map_err(http_error)?;
    response
        .into_json::<Value>()
        .map_err(|error| error.to_string())
}

fn status_with_token(
    portal: &str,
    token: &str,
    source: CredentialSource,
) -> Result<AuthStatus, String> {
    let response = agent()
        .get(&format!("{portal}/api/auth/status"))
        .set("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    Ok(AuthStatus {
        authenticated: response
            .get("authenticated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        kind: string_field(&response, "kind"),
        subject: string_field(&response, "subject"),
        name: string_field(&response, "name"),
        platform: string_field(&response, "platform"),
        scopes: response
            .get("scopes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        portal: portal.into(),
        source: source.label().into(),
    })
}

fn current_credential(portal: &str, include_legacy: bool) -> Option<Credential> {
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
    if include_legacy {
        if let Some(token) = legacy_token() {
            return Some(Credential {
                token,
                source: CredentialSource::LegacyDefaults,
            });
        }
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

#[cfg(target_os = "macos")]
fn legacy_token() -> Option<String> {
    let output = Command::new("defaults")
        .args(["read", LEGACY_DEFAULTS_DOMAIN, LEGACY_DEFAULTS_KEY])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(not(target_os = "macos"))]
fn legacy_token() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn delete_legacy_token() {
    let _ = Command::new("defaults")
        .args(["delete", LEGACY_DEFAULTS_DOMAIN, LEGACY_DEFAULTS_KEY])
        .output();
}

#[cfg(not(target_os = "macos"))]
fn delete_legacy_token() {}

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
}
