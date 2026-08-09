use crate::core::{NibError, Result};
use nib_protocol::{ArtifactSource, NibRequest};
use nib_storage::nib_file::NibFile;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackedRequest {
    pub file: PathBuf,
    pub request_id: String,
    pub revision: u64,
    pub embedded_artifacts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnpackedRequest {
    pub directory: PathBuf,
    pub request: PathBuf,
    pub request_id: String,
    pub revision: u64,
    pub embedded_artifacts: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectedRequestPack {
    pub file: PathBuf,
    pub request_id: String,
    pub revision: u64,
    pub request: NibRequest,
    pub artifacts: Vec<InspectedArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectedArtifact {
    pub id: String,
    pub artifact_type: String,
    pub mime_type: Option<String>,
    pub sha256: String,
    pub byte_length: u64,
    pub embedded: bool,
    pub blob_present: bool,
}

pub fn pack_request(input: &Path, output: Option<&Path>) -> Result<PackedRequest> {
    let request = read_request(input)?;
    let output = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| input.with_extension("nib"));
    let base = input.parent().unwrap_or_else(|| Path::new("."));
    let embedded = preflight_embedded_artifacts(base, &request)?;
    let nib = NibFile::create_request(&output, &request)?;
    let embedded_artifacts = store_embedded_artifacts(&nib, embedded)?;
    nib.save()?;
    Ok(PackedRequest {
        file: output,
        request_id: request.id,
        revision: request.revision,
        embedded_artifacts,
    })
}

pub fn unpack_request(
    file: &Path,
    request_id: &str,
    revision: u64,
    output: &Path,
) -> Result<UnpackedRequest> {
    let nib = NibFile::open(file)?;
    let request = load_request(&nib, request_id, revision)?;
    preflight_output_root(output)?;
    let request_path = output.join("request.json");
    preflight_new_file_destination(output, &request_path)?;
    let embedded = preflight_unpacked_artifacts(&nib, output, &request)?;
    fs::create_dir_all(output)?;
    write_pretty_json_new(&request_path, &request)?;
    let embedded_artifacts = write_embedded_artifacts(embedded)?;
    Ok(UnpackedRequest {
        directory: output.to_path_buf(),
        request: request_path,
        request_id: request.id,
        revision: request.revision,
        embedded_artifacts,
    })
}

pub fn inspect_request_pack(
    file: &Path,
    request_id: &str,
    revision: u64,
) -> Result<InspectedRequestPack> {
    let nib = NibFile::open(file)?;
    let request = load_request(&nib, request_id, revision)?;
    let mut artifacts = Vec::with_capacity(request.artifacts.len());
    for artifact in &request.artifacts {
        let (sha256, byte_length, embedded) = match &artifact.source {
            ArtifactSource::Embedded {
                sha256,
                byte_length,
                ..
            } => (sha256.clone(), *byte_length, true),
            ArtifactSource::External {
                sha256,
                byte_length,
                ..
            } => (sha256.clone(), *byte_length, false),
        };
        let blob_present = nib.get_artifact_blob(&sha256)?.is_some();
        artifacts.push(InspectedArtifact {
            id: artifact.id.clone(),
            artifact_type: artifact.artifact_type.clone(),
            mime_type: artifact.mime_type.clone(),
            sha256,
            byte_length,
            embedded,
            blob_present,
        });
    }
    Ok(InspectedRequestPack {
        file: file.to_path_buf(),
        request_id: request.id.clone(),
        revision: request.revision,
        request,
        artifacts,
    })
}

fn read_request(path: &Path) -> Result<NibRequest> {
    let value: Value = serde_json::from_slice(&fs::read(path)?)
        .map_err(|error| NibError::Other(error.to_string()))?;
    let request = NibRequest::from_value(value).map_err(|error| {
        NibError::Other(format!(
            "Invalid request document {}: {error}",
            path.display()
        ))
    })?;
    request
        .validate()
        .map_err(|error| NibError::Other(error.to_string()))?;
    Ok(request)
}

fn load_request(nib: &NibFile, request_id: &str, revision: u64) -> Result<NibRequest> {
    nib.get_request(request_id, revision)?.ok_or_else(|| {
        NibError::Other(format!(
            "Request {request_id} revision {revision} was not found"
        ))
    })
}

struct EmbeddedArtifact {
    path: PathBuf,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
}

fn preflight_embedded_artifacts(
    base: &Path,
    request: &NibRequest,
) -> Result<Vec<EmbeddedArtifact>> {
    let mut embedded = Vec::new();
    for artifact in &request.artifacts {
        let ArtifactSource::Embedded {
            path,
            sha256,
            byte_length,
            ..
        } = &artifact.source
        else {
            continue;
        };
        let path = validate_embedded_artifact_path(path)?;
        let bytes = fs::read(base.join(&path))?;
        if bytes.len() as u64 != *byte_length {
            return Err(NibError::Other(format!(
                "Artifact {} byte length mismatch: expected {}, got {}",
                artifact.id,
                byte_length,
                bytes.len()
            )));
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != *sha256 {
            return Err(NibError::Other(format!(
                "Artifact {} hash mismatch: expected {}, got {}",
                artifact.id, sha256, actual
            )));
        }
        embedded.push(EmbeddedArtifact {
            path,
            sha256: sha256.clone(),
            mime_type: artifact
                .mime_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            bytes,
        });
    }
    Ok(embedded)
}

fn store_embedded_artifacts(nib: &NibFile, embedded: Vec<EmbeddedArtifact>) -> Result<usize> {
    let count = embedded.len();
    for artifact in embedded {
        nib.put_artifact_blob(&artifact.sha256, &artifact.mime_type, &artifact.bytes)?;
    }
    Ok(count)
}

fn preflight_unpacked_artifacts(
    nib: &NibFile,
    output: &Path,
    request: &NibRequest,
) -> Result<Vec<EmbeddedArtifact>> {
    let mut embedded = Vec::new();
    for artifact in &request.artifacts {
        let ArtifactSource::Embedded { path, sha256, .. } = &artifact.source else {
            continue;
        };
        let path = validate_embedded_artifact_path(path)?;
        let destination = output.join(&path);
        preflight_new_file_destination(output, &destination)?;
        let blob = nib.get_artifact_blob(sha256)?.ok_or_else(|| {
            NibError::Other(format!(
                "Artifact blob {sha256} for {} was not found",
                artifact.id
            ))
        })?;
        embedded.push(EmbeddedArtifact {
            path: destination,
            sha256: blob.sha256,
            mime_type: blob.mime_type,
            bytes: blob.bytes,
        });
    }
    Ok(embedded)
}

fn write_embedded_artifacts(embedded: Vec<EmbeddedArtifact>) -> Result<usize> {
    let count = embedded.len();
    for artifact in embedded {
        if let Some(parent) = artifact.path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_new_file(&artifact.path, &artifact.bytes)?;
    }
    Ok(count)
}

fn preflight_output_root(output: &Path) -> Result<()> {
    if output.exists() {
        reject_symlink(output)?;
    }
    Ok(())
}

fn preflight_new_file_destination(output: &Path, destination: &Path) -> Result<()> {
    preflight_existing_parents(output, destination)?;
    match fs::symlink_metadata(destination) {
        Ok(_) => {
            return Err(NibError::Other(format!(
                "Unpacked destination already exists: {}",
                destination.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn preflight_existing_parents(output: &Path, destination: &Path) -> Result<()> {
    if output.exists() {
        reject_symlink(output)?;
    }
    let Some(parent) = destination.parent() else {
        return Ok(());
    };
    let Ok(relative_parent) = parent.strip_prefix(output) else {
        return Err(NibError::Other(format!(
            "Unpacked destination is outside output root: {}",
            destination.display()
        )));
    };

    let mut current = output.to_path_buf();
    for component in relative_parent.components() {
        current.push(component.as_os_str());
        if current.exists() {
            reject_symlink(&current)?;
        }
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(NibError::Other(format!(
            "Refusing to unpack through symlink: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_embedded_artifact_path(raw: &str) -> Result<PathBuf> {
    if raw.trim().is_empty() {
        return Err(invalid_embedded_path(raw));
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(invalid_embedded_path(raw));
    }

    let mut normalized = PathBuf::new();
    let mut saw_component = false;
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                normalized.push(part);
                saw_component = true;
            }
            Component::ParentDir
            | Component::CurDir
            | Component::RootDir
            | Component::Prefix(_) => return Err(invalid_embedded_path(raw)),
        }
    }
    if !saw_component {
        return Err(invalid_embedded_path(raw));
    }
    Ok(normalized)
}

fn invalid_embedded_path(path: &str) -> NibError {
    NibError::Other(format!("invalid embedded artifact path: {path:?}"))
}

fn write_pretty_json_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let json =
        serde_json::to_vec_pretty(value).map_err(|error| NibError::Other(error.to_string()))?;
    write_new_file(path, &json)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn pack_inspect_and_unpack_round_trip_embedded_request_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let artifact_path = directory.path().join("artifact.txt");
        fs::write(&artifact_path, b"ship it").unwrap();
        let sha256 = format!("{:x}", Sha256::digest(b"ship it"));
        let request_path = directory.path().join("request.json");
        fs::write(
            &request_path,
            serde_json::to_vec_pretty(&json!({
                "id": "req_cli",
                "formatVersion": "1.0",
                "revision": 1,
                "title": "CLI request",
                "source": {"type": "cli"},
                "artifacts": [{
                    "id": "primary",
                    "type": "text",
                    "mimeType": "text/plain",
                    "source": {
                        "type": "embedded",
                        "path": "artifact.txt",
                        "sha256": sha256,
                        "byteLength": 7
                    }
                }],
                "decision": {"type": "approval"},
                "createdAt": "2026-08-09T00:00:00Z"
            }))
            .unwrap(),
        )
        .unwrap();

        let packed = pack_request(&request_path, None).unwrap();
        assert_eq!(packed.request_id, "req_cli");
        assert_eq!(packed.embedded_artifacts, 1);

        let inspected = inspect_request_pack(&packed.file, "req_cli", 1).unwrap();
        assert_eq!(inspected.artifacts.len(), 1);
        assert!(inspected.artifacts[0].blob_present);

        let unpacked_dir = directory.path().join("unpacked");
        let unpacked = unpack_request(&packed.file, "req_cli", 1, &unpacked_dir).unwrap();
        assert_eq!(unpacked.embedded_artifacts, 1);
        assert_eq!(
            fs::read(unpacked_dir.join("artifact.txt")).unwrap(),
            b"ship it"
        );
        assert!(unpacked.request.exists());
    }

    #[test]
    fn pack_rejects_embedded_artifact_traversal_before_creating_output() {
        let directory = tempfile::tempdir().unwrap();
        let secret_path = directory.path().join("secret.txt");
        fs::write(&secret_path, b"secret").unwrap();
        let sha256 = format!("{:x}", Sha256::digest(b"secret"));
        let request_path = directory.path().join("manifest").join("request.json");
        fs::create_dir_all(request_path.parent().unwrap()).unwrap();
        fs::write(
            &request_path,
            serde_json::to_vec_pretty(&request_json("../secret.txt", &sha256, 6)).unwrap(),
        )
        .unwrap();
        let output = directory.path().join("packed.nib");

        let error = pack_request(&request_path, Some(&output)).unwrap_err();

        assert!(error.to_string().contains("invalid embedded artifact path"));
        assert!(
            !output.exists(),
            "invalid input must not leave a partial request pack"
        );
    }

    #[test]
    fn unpack_rejects_embedded_artifact_traversal_without_writing_outside_output() {
        let directory = tempfile::tempdir().unwrap();
        let pack = directory.path().join("request.nib");
        let output = directory.path().join("out");
        let outside = directory.path().join("outside.txt");
        let sha256 = format!("{:x}", Sha256::digest(b"owned"));
        let request: NibRequest =
            serde_json::from_value(request_json("../outside.txt", &sha256, 5)).unwrap();
        let nib = NibFile::create_request(&pack, &request).unwrap();
        nib.put_artifact_blob(&sha256, "text/plain", b"owned")
            .unwrap();

        let error = unpack_request(&pack, "req_cli", 1, &output).unwrap_err();

        assert!(error.to_string().contains("invalid embedded artifact path"));
        assert!(
            !outside.exists(),
            "invalid pack must not write outside the output directory"
        );
    }

    #[test]
    fn unpack_does_not_silently_overwrite_existing_embedded_artifact() {
        let directory = tempfile::tempdir().unwrap();
        let pack = directory.path().join("request.nib");
        let output = directory.path().join("out");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("artifact.txt"), b"keep me").unwrap();
        let sha256 = format!("{:x}", Sha256::digest(b"new data"));
        let request: NibRequest =
            serde_json::from_value(request_json("artifact.txt", &sha256, 8)).unwrap();
        let nib = NibFile::create_request(&pack, &request).unwrap();
        nib.put_artifact_blob(&sha256, "text/plain", b"new data")
            .unwrap();

        let error = unpack_request(&pack, "req_cli", 1, &output).unwrap_err();

        assert!(error.to_string().contains("already exists"));
        assert_eq!(fs::read(output.join("artifact.txt")).unwrap(), b"keep me");
    }

    #[test]
    fn unpack_does_not_silently_overwrite_existing_request_json() {
        let directory = tempfile::tempdir().unwrap();
        let pack = directory.path().join("request.nib");
        let output = directory.path().join("out");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("request.json"), b"keep me").unwrap();
        let sha256 = format!("{:x}", Sha256::digest(b"payload"));
        let request: NibRequest =
            serde_json::from_value(request_json("artifact.txt", &sha256, 7)).unwrap();
        let nib = NibFile::create_request(&pack, &request).unwrap();
        nib.put_artifact_blob(&sha256, "text/plain", b"payload")
            .unwrap();

        let error = unpack_request(&pack, "req_cli", 1, &output).unwrap_err();

        assert!(error.to_string().contains("already exists"));
        assert_eq!(fs::read(output.join("request.json")).unwrap(), b"keep me");
        assert!(!output.join("artifact.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unpack_rejects_symlink_parent_without_writing_outside_output() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let pack = directory.path().join("request.nib");
        let output = directory.path().join("out");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&output).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, output.join("sub")).unwrap();
        let sha256 = format!("{:x}", Sha256::digest(b"payload"));
        let request: NibRequest =
            serde_json::from_value(request_json("sub/file.txt", &sha256, 7)).unwrap();
        let nib = NibFile::create_request(&pack, &request).unwrap();
        nib.put_artifact_blob(&sha256, "text/plain", b"payload")
            .unwrap();

        let error = unpack_request(&pack, "req_cli", 1, &output).unwrap_err();

        assert!(error.to_string().contains("symlink"));
        assert!(!outside.join("file.txt").exists());
        assert_eq!(fs::read_link(output.join("sub")).unwrap(), outside);
    }

    fn request_json(path: &str, sha256: &str, byte_length: u64) -> Value {
        json!({
            "id": "req_cli",
            "formatVersion": "1.0",
            "revision": 1,
            "title": "CLI request",
            "source": {"type": "cli"},
            "artifacts": [{
                "id": "primary",
                "type": "text",
                "mimeType": "text/plain",
                "source": {
                    "type": "embedded",
                    "path": path,
                    "sha256": sha256,
                    "byteLength": byte_length
                }
            }],
            "decision": {"type": "approval"},
            "createdAt": "2026-08-09T00:00:00Z"
        })
    }
}
