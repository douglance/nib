use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::process::Command;
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const KEYCHAIN_SERVICE: &str = "com.douglance.nib.auth";
const NIB_CLOUD_ORIGIN: &str = "https://nibtool.com";
const KEYCHAIN_ACCOUNT: &str = "nibtool.com";

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

pub fn login(email: &str, name: Option<&str>) -> Result<AuthStatus, String> {
    if let Some(credential) = current_credential() {
        if let Ok(status) = status_with_token(&credential.token, credential.source) {
            return Ok(status);
        }
        if credential.source == CredentialSource::Keychain {
            delete_keychain_token();
        }
    }

    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let response = agent()
        .post(&format!("{NIB_CLOUD_ORIGIN}/api/auth/challenges"))
        .set("content-type", "application/json")
        .send_json(json!({
            "email": email.trim(),
            "pkceChallenge": challenge,
            "platform": "cli",
            "deviceName": name.unwrap_or("Nib CLI")
        }))
        .map_err(http_error)?
        .into_json::<Value>()
        .map_err(|error| error.to_string())?;
    let challenge_id = string_field(&response, "challengeId");
    if challenge_id.is_empty() {
        return Err("Nib could not start email sign-in".into());
    }
    eprintln!("Check {email} and confirm the Nib sign-in link.");

    for _ in 0..400 {
        let response = agent()
            .post(&format!(
                "{NIB_CLOUD_ORIGIN}/api/auth/challenges/{challenge_id}/token"
            ))
            .set("content-type", "application/json")
            .send_json(json!({ "verifier": verifier }))
            .map_err(http_error)?;
        if response.status() == 202 {
            thread::sleep(Duration::from_millis(1500));
            continue;
        }
        let issued = response
            .into_json::<Value>()
            .map_err(|error| error.to_string())?;
        let token = string_field(&issued, "token");
        if token.is_empty() {
            return Err("Nib sign-in did not return a session token".into());
        }
        store_keychain_token(&token)?;
        return status_with_token(&token, CredentialSource::Keychain);
    }
    Err("The Nib sign-in link expired. Run `nib auth login <email>` again.".into())
}

pub fn status() -> Result<AuthStatus, String> {
    let credential = resolved_credential()?;
    status_with_token(&credential.token, credential.source)
}

pub fn logout() -> Result<AuthLogout, String> {
    let credential = current_credential().ok_or_else(|| "Nib is not authenticated".to_string())?;
    let agent = agent();
    let request = agent
        .post(&format!("{NIB_CLOUD_ORIGIN}/api/auth/logout"))
        .set("authorization", &format!("Bearer {}", credential.token));
    let cleared = if credential.source == CredentialSource::Environment {
        false
    } else {
        delete_keychain_token();
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

pub fn resolved_access_token() -> Result<String, String> {
    Ok(resolved_credential()?.token)
}

pub fn cloud_origin() -> &'static str {
    NIB_CLOUD_ORIGIN
}

fn resolved_credential() -> Result<Credential, String> {
    current_credential().ok_or_else(|| {
        "Nib is not authenticated. Run `nib auth login` or set NIB_AUTH_TOKEN for automation."
            .to_string()
    })
}

fn status_with_token(token: &str, source: CredentialSource) -> Result<AuthStatus, String> {
    let response = agent()
        .get(&format!("{NIB_CLOUD_ORIGIN}/api/auth/session"))
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
        kind: "session".into(),
        subject: response
            .pointer("/account/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        name: response
            .pointer("/session/name")
            .and_then(Value::as_str)
            .unwrap_or("Nib")
            .into(),
        platform: response
            .pointer("/session/platform")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        scopes: Vec::new(),
        portal: NIB_CLOUD_ORIGIN.into(),
        source: source.label().into(),
    })
}

fn current_credential() -> Option<Credential> {
    if let Ok(token) = std::env::var("NIB_AUTH_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(Credential {
                token,
                source: CredentialSource::Environment,
            });
        }
    }
    if let Some(token) = keychain_token() {
        return Some(Credential {
            token,
            source: CredentialSource::Keychain,
        });
    }
    None
}

#[cfg(target_os = "macos")]
fn keychain_token() -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
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
fn keychain_token() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn store_keychain_token(token: &str) -> Result<(), String> {
    let result = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
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
fn store_keychain_token(_token: &str) -> Result<(), String> {
    Err(
        "Secure credential persistence is not available on this platform; use NIB_AUTH_TOKEN"
            .into(),
    )
}

#[cfg(target_os = "macos")]
fn delete_keychain_token() -> bool {
    Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_token() -> bool {
    false
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
    fn cloud_origin_is_fixed() {
        assert_eq!(cloud_origin(), "https://nibtool.com");
    }

    #[test]
    fn keychain_account_is_fixed() {
        assert_eq!(KEYCHAIN_ACCOUNT, "nibtool.com");
    }
}
