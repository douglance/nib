# Nib Request protocol v1

This reference is for developers who need software to request and consume a structured decision. Protocol use does not require Nib Cloud.

## Request lifecycle

```text
Producer -> Request -> Route -> Review -> Decision -> Event -> Continuation
```

A request contains evidence, a decision requirement, optional routing and approval policy, and an optional continuation.

## Portable types

Use one of these version 1 sources:

| Surface | Location |
| --- | --- |
| Rust | `crates/nib-protocol` |
| TypeScript | `packages/protocol` |
| JSON Schema | `schemas/protocol` |
| Local file | `.nib` SQLite schema version 4 |

The protocol rejects an unsupported major version. A version 1 reader preserves unknown extension fields where the public model permits them.

## Artifacts and assets

Every artifact has an opaque ID, an extensible type, optional MIME metadata, and one source.

An embedded source records a relative path, SHA-256 digest, and byte length. A `.nib` v4 file stores those raw bytes once in `artifact_blobs`.

An external source records an HTTP or HTTPS URL, SHA-256 digest, and byte length. Do not put credentials or signed URL secrets in a portable request.

Nib does not recompress embedded media. The stored digest identifies the exact bytes that the reviewer should receive.

## Revisions and decisions

A request ID remains stable. Each material evidence or requirement change increments `revision`.

Decisions record the request revision they reviewed. Earlier decisions remain in history. They do not satisfy the new revision unless a policy explicitly permits carry-forward.

Decision outcomes are `approved`, `rejected`, and `changes_requested`. Request status also supports `pending`, `expired`, and `cancelled`.

## Events

Each event has an opaque ID, request ID, request revision, monotonically increasing sequence, timestamp, and payload. Optional hashes support tamper evidence.

Consumers resume with an exclusive `after` sequence. A repeated event ID or sequence is a duplicate, not a second lifecycle transition.

## Regenerate schemas

From the repository root, run:

```sh
cargo run -p nib-protocol --bin export_schemas -- schemas/protocol
```

Expected result: the command writes the five versioned schema documents in `schemas/protocol`.
