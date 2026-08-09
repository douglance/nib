use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("schemas/protocol"));
    fs::create_dir_all(&output)?;

    for (file_name, document) in nib_protocol::schema_documents() {
        let mut bytes = serde_json::to_vec_pretty(&document)?;
        bytes.push(b'\n');
        fs::write(output.join(file_name), bytes)?;
    }

    Ok(())
}
