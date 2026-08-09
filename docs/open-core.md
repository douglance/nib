# Nib open-core boundary

Nib makes the portable decision protocol open source. Nib Cloud sells the managed network and operating controls around it.

## Apache-2.0 components

- Nib Request types, JSON Schemas, compatibility rules, and policy evaluation
- `.nib` SQLite format, asset storage, pack, unpack, and inspection
- CLI and language SDKs
- Self-hosted request Worker and browser reviewer
- GitHub, Playwright, Cypress, and messaging adapters
- Local creation, review, decisions, feedback, events, and continuation clients

## Private Nib Cloud components

- Production tenant isolation, account administration, and billing
- Hosted integration credentials and delivery infrastructure
- Managed routing history, approval graph data, and analytics
- Abuse prevention, security operations, SSO, SCIM, and enterprise controls
- Production secrets, incident tools, deployment configuration, and service operations

The stable seams are the Nib Request API and the optional `generate_ui` artifact generator. Public clients can call them. Production account and commercial controls remain private.

## Data ownership

The format implementation is open source. A `.nib` file can still contain proprietary customer evidence. Operators must apply request-level and artifact-level authorization to hosted files.

Portable requests must not contain secrets. Hosted systems can resolve private credentials at delivery time without writing them into the request.

## Commercial rule

Reviewers, guest participants, repositories, and self-hosted use are free. Nib Cloud charges creators for hosted request revisions and optional managed services.

Run `node scripts/check-open-core-boundary.mjs` before publishing a public branch. It rejects known private paths, credential names, accidental Cargo publication, and license drift.
