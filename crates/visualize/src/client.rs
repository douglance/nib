use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue};

use crate::domain::{GenerationRequest, GenerationResponse, VisualizeError};

#[async_trait]
pub trait Generator: Send + Sync {
    async fn generate(
        &self,
        request: GenerationRequest,
        tenant_id: Option<&str>,
        trial_network: Option<&str>,
    ) -> Result<GenerationResponse, VisualizeError>;
}

#[derive(Clone)]
pub struct HttpGenerator {
    client: reqwest::Client,
    endpoint: String,
}

impl HttpGenerator {
    pub fn from_env() -> Result<Self, VisualizeError> {
        let endpoint = std::env::var("VISUALIZE_BACKEND_URL").unwrap_or_else(|_| {
            "https://visualize.doug-lance.workers.dev/internal/v1/generate".to_string()
        });
        let mut headers = HeaderMap::new();
        if let Ok(tenant_id) = std::env::var("VISUALIZE_DEV_TENANT")
            && let Some(value) = development_tenant_header(&endpoint, Some(&tenant_id))?
        {
            headers.insert("x-visualize-dev-tenant", value);
        }
        if let Ok(token) = std::env::var("VISUALIZE_ACCESS_TOKEN") {
            headers.insert(
                "cf-access-token",
                HeaderValue::from_str(&token)
                    .map_err(|error| VisualizeError::Service(error.to_string()))?,
            );
        }
        let service_client_id = std::env::var("VISUALIZE_ACCESS_CLIENT_ID").ok();
        let service_client_secret = std::env::var("VISUALIZE_ACCESS_CLIENT_SECRET").ok();
        match (service_client_id, service_client_secret) {
            (Some(client_id), Some(client_secret)) => {
                headers.insert(
                    "cf-access-client-id",
                    HeaderValue::from_str(&client_id)
                        .map_err(|error| VisualizeError::Service(error.to_string()))?,
                );
                headers.insert(
                    "cf-access-client-secret",
                    HeaderValue::from_str(&client_secret)
                        .map_err(|error| VisualizeError::Service(error.to_string()))?,
                );
            }
            (None, None) => {}
            _ => {
                return Err(VisualizeError::Service(
                    "set both VISUALIZE_ACCESS_CLIENT_ID and VISUALIZE_ACCESS_CLIENT_SECRET"
                        .to_string(),
                ));
            }
        }
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|error| VisualizeError::Service(error.to_string()))?;
        Ok(Self { client, endpoint })
    }
}

fn development_tenant_header(
    endpoint: &str,
    tenant_id: Option<&str>,
) -> Result<Option<HeaderValue>, VisualizeError> {
    let Some(tenant_id) = tenant_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let endpoint = reqwest::Url::parse(endpoint).map_err(|error| {
        VisualizeError::Service(format!("invalid VISUALIZE_BACKEND_URL: {error}"))
    })?;
    let loopback = endpoint.scheme() == "http"
        && matches!(
            endpoint.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "host.docker.internal")
        );
    if !loopback {
        return Err(VisualizeError::Service(
            "VISUALIZE_DEV_TENANT is only permitted with an HTTP loopback backend".to_string(),
        ));
    }
    HeaderValue::from_str(tenant_id)
        .map(Some)
        .map_err(|error| VisualizeError::Service(format!("invalid VISUALIZE_DEV_TENANT: {error}")))
}

#[async_trait]
impl Generator for HttpGenerator {
    async fn generate(
        &self,
        request: GenerationRequest,
        tenant_id: Option<&str>,
        trial_network: Option<&str>,
    ) -> Result<GenerationResponse, VisualizeError> {
        let mut request_builder = self.client.post(&self.endpoint).json(&request);
        if let Some(tenant_id) = tenant_id {
            request_builder = request_builder.header("x-visualize-tenant", tenant_id);
        }
        if let Some(trial_network) = trial_network {
            request_builder = request_builder.header("x-visualize-trial-network", trial_network);
        }
        let response = request_builder
            .send()
            .await
            .map_err(|error| VisualizeError::Service(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_else(|_| status.to_string());
            return Err(VisualizeError::Service(message));
        }
        response
            .json()
            .await
            .map_err(|error| VisualizeError::Service(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_tenant_is_allowed_for_loopback_http() {
        let header = development_tenant_header(
            "http://127.0.0.1:8787/internal/v1/generate",
            Some("dogfood@visualize.local"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(header, "dogfood@visualize.local");
    }

    #[test]
    fn development_tenant_is_rejected_for_remote_backends() {
        let error = development_tenant_header(
            "https://visualize.example.com/internal/v1/generate",
            Some("dogfood@visualize.local"),
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
            Some("dogfood@visualize.local"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(header, "dogfood@visualize.local");
    }
}
