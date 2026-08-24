use async_trait::async_trait;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

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
    const ENDPOINT: &'static str = "https://nibtool.com/internal/v1/generate";

    pub fn for_account(access_token: &str) -> Result<Self, UiError> {
        let mut headers = HeaderMap::new();
        let authorization = HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|error| UiError::Service(error.to_string()))?;
        headers.insert(AUTHORIZATION, authorization);
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|error| UiError::Service(error.to_string()))?;
        Ok(Self {
            client,
            endpoint: Self::ENDPOINT.to_string(),
        })
    }
}

#[async_trait]
impl Generator for HttpGenerator {
    async fn generate(
        &self,
        request: GenerationRequest,
        _tenant_id: Option<&str>,
        _trial_network: Option<&str>,
    ) -> Result<GenerationResponse, UiError> {
        let response = self
            .client
            .post(&self.endpoint)
            .json(&request)
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
    fn account_generator_uses_the_fixed_cloud_endpoint() {
        let generator = HttpGenerator::for_account("nib_session_test").unwrap();
        assert_eq!(generator.endpoint, HttpGenerator::ENDPOINT);
    }
}
