//! Helper constructors for `incurs::schema::FieldMeta`.
//!
//! Every nib command's `CommandDef` is built from hand-written `FieldMeta` vecs
//! (not incurs' derive-macro/builder sugar — see the migration plan for why:
//! that path has zero real usage/tests anywhere in incurs' own codebase, too
//! risky to bet a big-bang CLI migration on). These helpers exist purely to cut
//! down the struct-literal boilerplate every field needs, mirroring the
//! `make_field`/`make_field_with_default` helpers incurs' own `tests/e2e.rs`
//! uses for the identical purpose.

use incurs::schema::{to_kebab, FieldMeta, FieldType};
use serde_json::Value;

/// A required or optional field with no default value.
pub fn field(
    name: &'static str,
    description: &'static str,
    field_type: FieldType,
    required: bool,
) -> FieldMeta {
    FieldMeta {
        name,
        cli_name: to_kebab(name),
        description: Some(description),
        field_type,
        required,
        default: None,
        alias: None,
        deprecated: false,
        env_name: None,
    }
}

/// An optional field with a default value (implies `required: false`).
pub fn field_with_default(
    name: &'static str,
    description: &'static str,
    field_type: FieldType,
    default: Value,
) -> FieldMeta {
    FieldMeta {
        name,
        cli_name: to_kebab(name),
        description: Some(description),
        field_type,
        required: false,
        default: Some(default),
        alias: None,
        deprecated: false,
        env_name: None,
    }
}

/// A field with a short single-character alias (e.g. `-o`/`--output`).
pub fn field_with_alias(
    name: &'static str,
    description: &'static str,
    field_type: FieldType,
    required: bool,
    alias: char,
) -> FieldMeta {
    let mut f = field(name, description, field_type, required);
    f.alias = Some(alias);
    f
}

/// A field with both a short alias and a default value.
pub fn field_with_alias_and_default(
    name: &'static str,
    description: &'static str,
    field_type: FieldType,
    default: Value,
    alias: char,
) -> FieldMeta {
    let mut f = field_with_default(name, description, field_type, default);
    f.alias = Some(alias);
    f
}

/// Reads a required/optional path-shaped string field out of a parsed
/// `serde_json::Value` map (incurs has no native path `FieldType` — every
/// `PathBuf` field is declared as `FieldType::String` and read back through
/// this helper). Returns a `CommandResult::Error` ready to hand straight back
/// from a handler when the field is missing or not a string.
pub fn path_arg(
    value: &Value,
    key: &str,
) -> Result<std::path::PathBuf, incurs::output::CommandResult> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(std::path::PathBuf::from)
        .ok_or_else(|| incurs::output::CommandResult::Error {
            code: "MISSING_ARG".to_string(),
            message: format!("Missing or invalid `{key}` argument"),
            retryable: false,
            exit_code: Some(1),
            cta: None,
        })
}

/// Reads an optional path-shaped string field, returning `None` if absent.
pub fn optional_path_arg(value: &Value, key: &str) -> Option<std::path::PathBuf> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(std::path::PathBuf::from)
}
