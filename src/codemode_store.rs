//! Durable file-backed stores for Incurs Code Mode.

use async_trait::async_trait;
use incurs_codemode::{ArtifactRef, ArtifactStore, ExecutionState, RuntimeStore, Snippet};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use uuid::Uuid;

pub struct FileRuntimeStore {
    root: PathBuf,
    lock: Mutex<()>,
}

impl FileRuntimeStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("executions")).map_err(|error| error.to_string())?;
        fs::create_dir_all(root.join("snippets")).map_err(|error| error.to_string())?;
        Ok(Self {
            root,
            lock: Mutex::new(()),
        })
    }

    fn execution_path(&self, id: &str) -> PathBuf {
        self.root
            .join("executions")
            .join(format!("{}.json", key(id)))
    }

    fn snippet_path(&self, name: &str) -> PathBuf {
        self.root
            .join("snippets")
            .join(format!("{}.json", key(name)))
    }
}

#[async_trait]
impl RuntimeStore for FileRuntimeStore {
    async fn get_execution(&self, id: &str) -> Result<Option<ExecutionState>, String> {
        let _guard = self.lock.lock().await;
        read_optional(&self.execution_path(id))
    }

    async fn put_execution(&self, execution: &ExecutionState) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        write_atomic(&self.execution_path(&execution.id), execution)
    }

    async fn list_executions(&self) -> Result<Vec<ExecutionState>, String> {
        let _guard = self.lock.lock().await;
        read_all(&self.root.join("executions"))
    }

    async fn delete_execution(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        remove_file_if_present(&self.execution_path(id))
    }

    async fn get_snippet(&self, name: &str) -> Result<Option<Snippet>, String> {
        let _guard = self.lock.lock().await;
        read_optional(&self.snippet_path(name))
    }

    async fn put_snippet(&self, snippet: &Snippet) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        write_atomic(&self.snippet_path(&snippet.name), snippet)
    }

    async fn list_snippets(&self) -> Result<Vec<Snippet>, String> {
        let _guard = self.lock.lock().await;
        read_all(&self.root.join("snippets"))
    }

    async fn delete_snippet(&self, name: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().await;
        let path = self.snippet_path(name);
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(path).map_err(|error| error.to_string())?;
        Ok(true)
    }
}

pub struct FileArtifactStore {
    root: PathBuf,
    lock: Mutex<()>,
}

impl FileArtifactStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(Self {
            root,
            lock: Mutex::new(()),
        })
    }

    fn execution_dir(&self, execution_id: &str) -> PathBuf {
        self.root.join(key(execution_id))
    }

    fn artifact_path(&self, execution_id: &str, artifact_id: &str) -> PathBuf {
        self.execution_dir(execution_id)
            .join(format!("{}.json", key(artifact_id)))
    }
}

#[async_trait]
impl ArtifactStore for FileArtifactStore {
    async fn put(&self, execution_id: &str, value: &Value) -> Result<ArtifactRef, String> {
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let id = format!(
            "{:x}",
            Sha256::digest([execution_id.as_bytes(), bytes.as_slice()].concat())
        );
        let _guard = self.lock.lock().await;
        let path = self.artifact_path(execution_id, &id);
        write_bytes_atomic(&path, &bytes)?;
        Ok(ArtifactRef {
            id,
            execution_id: execution_id.to_string(),
            bytes: bytes.len(),
            preview: truncate(String::from_utf8_lossy(&bytes).into_owned(), 512),
        })
    }

    async fn get(&self, execution_id: &str, artifact_id: &str) -> Result<Option<Value>, String> {
        let _guard = self.lock.lock().await;
        read_optional(&self.artifact_path(execution_id, artifact_id))
    }

    async fn delete_execution(&self, execution_id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        let directory = self.execution_dir(execution_id);
        if directory.exists() {
            fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn read_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("{}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_all<T: DeserializeOwned>(directory: &Path) -> Result<Vec<T>, String> {
    let mut values = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|error| error.to_string())?;
        values.push(serde_json::from_slice(&bytes).map_err(|error| error.to_string())?);
    }
    Ok(values)
}

fn write_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_bytes_atomic(path, &bytes)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".tmp-{}", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn truncate(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value.push_str("...");
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use incurs_codemode::{ExecutionStatus, RuntimeStore};

    #[tokio::test]
    async fn execution_survives_a_store_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileRuntimeStore::new(directory.path().to_path_buf()).unwrap();
        let state = ExecutionState {
            id: "execution-1".to_string(),
            code: "return 1".to_string(),
            status: ExecutionStatus::Completed,
            log: vec![],
            result: Some(serde_json::json!(1)),
            error: None,
            logs: vec![],
            connectors: vec!["nib".to_string()],
            capabilities: None,
            events: vec![],
            created_at: 1,
            updated_at: 2,
        };
        store.put_execution(&state).await.unwrap();
        drop(store);

        let reopened = FileRuntimeStore::new(directory.path().to_path_buf()).unwrap();
        assert_eq!(
            reopened
                .get_execution("execution-1")
                .await
                .unwrap()
                .unwrap()
                .result,
            Some(serde_json::json!(1))
        );
    }
}
