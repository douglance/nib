-- Compare this marker before committing a Stripe read so concurrent webhook
-- reconciliation cannot overwrite a newer account billing state.
ALTER TABLE accounts ADD COLUMN stripe_billing_event_id TEXT;
