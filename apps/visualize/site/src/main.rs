use std::path::PathBuf;

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() != Some("--export") {
        return Err("usage: visualize-site --export [directory]".into());
    }

    let output = arguments
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist"));
    visualize_site::export_site(&output).await
}
