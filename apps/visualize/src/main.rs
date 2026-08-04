use std::sync::Arc;

use visualize::catalog::build_cli;
use visualize::client::HttpGenerator;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let generator = HttpGenerator::from_env()?;
    let cli = build_cli(Arc::new(generator));
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() == Some("--http") {
        let address = arguments
            .next()
            .unwrap_or_else(|| "127.0.0.1:8080".to_string())
            .parse()?;
        return incurs::http::serve_http(&cli, address).await;
    }
    cli.serve().await
}
