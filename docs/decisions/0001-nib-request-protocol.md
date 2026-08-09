Artifact: Architecture decision record NIB-ADR-0001
Subject: Nib Request protocol and open-core boundary
Status: approved
Version: 1.0
Owner: Nib maintainers
Approvers: Doug Lance
Inputs: NIB-SRS-1.0 and the approved 2026-08-09 implementation plan
Governing references: ISO/IEC/IEEE 15289:2019; IEEE 1016-2009 as specialist precedent; Apache License 2.0
Tailoring: This record replaces a full Software Design Description because it captures one architecture boundary.

# Nib Request protocol and open-core boundary

## Decision

NIB-DEC-001 Nib uses `NibRequest` as the portable unit of human or agent judgment.

NIB-DEC-002 Protocol major version 1 uses JSON documents and preserves unknown fields within the same major version.

NIB-DEC-003 A `.nib` file uses SQLite as its canonical physical container.

NIB-DEC-004 `.nib` schema version 4 stores requests, content-addressed artifact bytes, decisions, feedback, and replayable events.

NIB-DEC-005 Images, videos, HTML, JSON, and other files use one artifact model. Nib stores embedded bytes without media recompression.

NIB-DEC-006 The protocol, schemas, local storage, policy evaluator, clients, reviewer, and adapters use the Apache-2.0 license.

NIB-DEC-007 Nib Cloud keeps production tenancy, billing, credentials, managed delivery, abuse controls, analytics, and enterprise operations private.

## Consequences

Third parties can create, inspect, render, decide, and consume `.nib` files without Nib Cloud.

Nib Cloud earns revenue from hosted request creation, routing, delivery, storage, and organization controls. Reviewers and self-hosted protocol use remain free.

Existing `.nib` schema versions 1 through 3 remain readable. The first protocol write upgrades an older file in one transaction.

Nib rejects unsupported protocol or storage major versions. It preserves same-major extension fields where the public model permits them.

## Rejected alternatives

- ZIP is not the canonical `.nib` container because the existing SQLite format already supports atomic updates, queries, and compatibility.
- A proprietary request format is rejected because it would prevent portable agent adoption.
- Reviewer-seat pricing is rejected because it would weaken guest review and product propagation.
- Generation output is not the product primitive. Generated UI is an optional artifact source.

## Handoff

Receiver: Release verification
Accepted inputs: NIB-SRS-1.0 and NIB-ADR-0001 version 1.0
Decisions: NIB-DEC-001 through NIB-DEC-007 accepted for implementation
Produced outputs: `nib-protocol`, `@nib/protocol`, JSON Schema v1, and `.nib` schema v4
Verification evidence: full Rust workspace tests and Clippy; protocol schema drift tests; `.nib` v1-v4 compatibility tests; TypeScript package tests and type checks; Cloudflare Worker tests and deployment dry runs; public/private boundary checks; desktop and mobile reviewer inspection.
Open items: none for version 1.0.
Acceptance checks: Protocol fixtures, v1-v3 reads, v4 writes, raw media bytes, hosted R2 uploads, guest review, tenant isolation, request metering, and repository boundaries passed before release.
