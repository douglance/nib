pub mod catalog;
pub mod client;
pub mod domain;

#[cfg(test)]
mod contract_tests {
    use crate::domain::{GenerationRequest, Quality, Resolution};

    #[test]
    fn fast_quality_rejects_non_1k_resolution() {
        let request = GenerationRequest::test_request(Quality::Fast, Resolution::TwoK);
        let error = request.validate().expect_err("fast is a 1K model");
        assert_eq!(error.code(), "UNSUPPORTED_QUALITY_RESOLUTION");
    }

    #[test]
    fn no_more_than_three_references_are_accepted() {
        let mut request = GenerationRequest::test_request(Quality::Standard, Resolution::TwoK);
        request.references = vec![Default::default(); 4];
        let error = request
            .validate()
            .expect_err("reference limit must be enforced");
        assert_eq!(error.code(), "TOO_MANY_REFERENCES");
    }

    #[test]
    fn rate_card_is_stable() {
        assert_eq!(Quality::Fast.price_cents(Resolution::OneK).unwrap(), 12);
        assert_eq!(Quality::Standard.price_cents(Resolution::TwoK).unwrap(), 32);
        assert_eq!(Quality::Pro.price_cents(Resolution::FourK).unwrap(), 75);
    }
}
