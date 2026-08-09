use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue};

use crate::domain::{GenerationRequest, GenerationResponse, UiError};

#[async_trait]
pub trait Generator: Send + Sync {
    async fn generate(
        &self,
        request: GenerationRequest,
        tenant_id: Option<&str>,
        trial_network: Option<&str>,
    ) -> Result<GenerationResponse, UiError>;
}

#[derive(Clone)]
pub struct HttpGenerator {
    client: reqwest::Client,
    endpoint: String,
}

impl HttpGenerator {
    pub fn from_env() -> Result<Self, UiError> {
        let endpoint = std::env::var("NIB_BACKEND_URL").unwrap_or_else(|_| {
            "https://nib.doug-lance.workers.dev/internal/v1/generate".to_string()
        });
        let mut headers = HeaderMap::new();
        if let Ok(tenant_id) = std::env::var("NIB_DEV_TENANT")
            && let Some(value) = development_tenant_header(&endpoint, Some(&tenant_id))?
        {
            headers.insert("x-nib-dev-tenant", value);
        }
        if let Ok(token) = std::env::var("NIB_ACCESS_TOKEN") {
            headers.insert(reqwest::header::AUTHORIZATION, access_token_header(&token)?);
        }
        let service_client_id = std::env::var("NIB_ACCESS_CLIENT_ID").ok();
        let service_client_secret = std::env::var("NIB_ACCESS_CLIENT_SECRET").ok();
        match (service_client_id, service_client_secret) {
            (Some(client_id), Some(client_secret)) => {
                headers.insert(
                    "cf-access-client-id",
                    HeaderValue::from_str(&client_id)
                        .map_err(|error| UiError::Service(error.to_string()))?,
                );
                headers.insert(
                    "cf-access-client-secret",
                    HeaderValue::from_str(&client_secret)
                        .map_err(|error| UiError::Service(error.to_string()))?,
                );
            }
            (None, None) => {}
            _ => {
                return Err(UiError::Service(
                    "set both NIB_ACCESS_CLIENT_ID and NIB_ACCESS_CLIENT_SECRET".to_string(),
                ));
            }
        }
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|error| UiError::Service(error.to_string()))?;
        Ok(Self { client, endpoint })
    }
}

fn access_token_header(token: &str) -> Result<HeaderValue, UiError> {
    HeaderValue::from_str(&format!("Bearer {}", token.trim()))
        .map_err(|error| UiError::Service(error.to_string()))
}

fn development_tenant_header(
    endpoint: &str,
    tenant_id: Option<&str>,
) -> Result<Option<HeaderValue>, UiError> {
    let Some(tenant_id) = tenant_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let endpoint = reqwest::Url::parse(endpoint)
        .map_err(|error| UiError::Service(format!("invalid NIB_BACKEND_URL: {error}")))?;
    let loopback = endpoint.scheme() == "http"
        && matches!(
            endpoint.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "host.docker.internal")
        );
    if !loopback {
        return Err(UiError::Service(
            "NIB_DEV_TENANT is only permitted with an HTTP loopback backend".to_string(),
        ));
    }
    HeaderValue::from_str(tenant_id)
        .map(Some)
        .map_err(|error| UiError::Service(format!("invalid NIB_DEV_TENANT: {error}")))
}

#[async_trait]
impl Generator for HttpGenerator {
    async fn generate(
        &self,
        request: GenerationRequest,
        tenant_id: Option<&str>,
        trial_network: Option<&str>,
    ) -> Result<GenerationResponse, UiError> {
        let mut request_builder = self.client.post(&self.endpoint).json(&request);
        if let Some(tenant_id) = tenant_id {
            request_builder = request_builder.header("x-nib-tenant", tenant_id);
        }
        if let Some(trial_network) = trial_network {
            request_builder = request_builder.header("x-nib-trial-network", trial_network);
        }
        let response = request_builder
            .send()
            .await
            .map_err(|error| UiError::Service(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_else(|_| status.to_string());
            return Err(UiError::Service(message));
        }
        response
            .json()
            .await
            .map_err(|error| UiError::Service(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_tenant_is_allowed_for_loopback_http() {
        let header = development_tenant_header(
            "http://127.0.0.1:8787/internal/v1/generate",
            Some("dogfood@nib.local"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(header, "dogfood@nib.local");
    }

    #[test]
    fn customer_access_token_uses_bearer_authentication() {
        assert_eq!(
            access_token_header(" nib_live_example ").unwrap(),
            "Bearer nib_live_example"
        );
    }

    #[test]
    fn development_tenant_is_rejected_for_remote_backends() {
        let error = development_tenant_header(
            "https://nib.example.com/internal/v1/generate",
            Some("dogfood@nib.local"),
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("only permitted with an HTTP loopback backend")
        );
    }

    #[test]
    fn development_tenant_is_allowed_for_docker_host_gateway() {
        let header = development_tenant_header(
            "http://host.docker.internal:8790/internal/v1/generate",
            Some("dogfood@nib.local"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(header, "dogfood@nib.local");
    }
}
