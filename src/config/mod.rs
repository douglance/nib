//! Nib configuration: the seam for swapping which external CLI does image
//! generation and judgment.
//!
//! Loaded from `dirs::config_dir()/nib/config.toml`, all fields optional:
//!
//! ```toml
//! [generate]
//! command = "imago"        # generator CLI; must speak the imago JSON contract
//! [judge]
//! command = "imago"
//! ```
//!
//! Precedence (lowest to highest): built-in default -> config file -> env var.
//! `NIB_GENERATE_COMMAND` / `NIB_JUDGE_COMMAND` override the file.

use serde::Deserialize;
use std::path::PathBuf;

fn default_command() -> String {
    "imago".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GenerateConfig {
    #[serde(default = "default_command")]
    pub command: String,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            command: default_command(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct JudgeConfig {
    #[serde(default = "default_command")]
    pub command: String,
}

impl Default for JudgeConfig {
    fn default() -> Self {
        Self {
            command: default_command(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub generate: GenerateConfig,
    #[serde(default)]
    pub judge: JudgeConfig,
}

/// Path to the config file: `dirs::config_dir()/nib/config.toml`.
pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nib")
        .join("config.toml")
}

/// Parse a config from TOML text. Falls back to defaults if the TOML is
/// malformed rather than failing the whole CLI over a bad config file.
pub fn parse_config(toml_str: &str) -> Config {
    toml::from_str(toml_str).unwrap_or_default()
}

/// Apply env var overrides on top of a base config. `NIB_GENERATE_COMMAND`
/// and `NIB_JUDGE_COMMAND`, when set, beat whatever the file (or default)
/// provided.
fn apply_overrides(config: &mut Config, generate: Option<String>, judge: Option<String>) {
    if let Some(command) = generate {
        config.generate.command = command;
    }
    if let Some(command) = judge {
        config.judge.command = command;
    }
}

/// Load the effective config: defaults, then the config file if present,
/// then env var overrides.
pub fn load() -> Config {
    let mut config = match std::fs::read_to_string(config_path()) {
        Ok(contents) => parse_config(&contents),
        Err(_) => Config::default(),
    };

    apply_overrides(
        &mut config,
        std::env::var("NIB_GENERATE_COMMAND").ok(),
        std::env::var("NIB_JUDGE_COMMAND").ok(),
    );

    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_imago_for_both_commands() {
        let config = Config::default();
        assert_eq!(config.generate.command, "imago");
        assert_eq!(config.judge.command, "imago");
    }

    #[test]
    fn file_layer_overrides_defaults() {
        let config = parse_config(
            r#"
            [generate]
            command = "my-generator"
            [judge]
            command = "my-judge"
            "#,
        );
        assert_eq!(config.generate.command, "my-generator");
        assert_eq!(config.judge.command, "my-judge");
    }

    #[test]
    fn file_layer_partial_override_keeps_other_default() {
        let config = parse_config(
            r#"
            [generate]
            command = "my-generator"
            "#,
        );
        assert_eq!(config.generate.command, "my-generator");
        assert_eq!(config.judge.command, "imago");
    }

    #[test]
    fn malformed_toml_falls_back_to_defaults() {
        let config = parse_config("this is not valid toml {{{");
        assert_eq!(config, Config::default());
    }

    #[test]
    fn env_layer_overrides_file_layer() {
        let mut config = parse_config(
            r#"
            [generate]
            command = "my-generator"
            [judge]
            command = "my-judge"
            "#,
        );
        apply_overrides(
            &mut config,
            Some("env-generator".to_string()),
            Some("env-judge".to_string()),
        );
        assert_eq!(config.generate.command, "env-generator");
        assert_eq!(config.judge.command, "env-judge");
    }

    #[test]
    fn env_layer_partial_override_keeps_file_value() {
        let mut config = parse_config(
            r#"
            [generate]
            command = "my-generator"
            [judge]
            command = "my-judge"
            "#,
        );
        apply_overrides(&mut config, Some("env-generator".to_string()), None);
        assert_eq!(config.generate.command, "env-generator");
        assert_eq!(config.judge.command, "my-judge");
    }
}
