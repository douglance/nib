use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;

fn nib_bin() -> &'static str {
    env!("CARGO_BIN_EXE_nib")
}

#[test]
fn verify_unsatisfied_response_prints_json_and_exits_nonzero() {
    let server = MockServer::start(vec![MockResponse {
        status: 200,
        body: r#"{"satisfied":false,"state":"pending","reason":"missing_receipt"}"#.into(),
    }]);

    let output = Command::new(nib_bin())
        .env("NIB_CLAP_COMPAT", "1")
        .env("NIB_PORTAL_URL", server.url())
        .env("NIB_AUTH_TOKEN", "test-token")
        .args([
            "request",
            "verify",
            "review-1",
            "--project",
            "project-1",
            "--manifest-hash",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .output()
        .expect("run nib request verify");

    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        !stdout.trim().is_empty(),
        "expected structured stdout; stderr was: {stderr}"
    );
    let json: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(json["satisfied"], false);
    assert!(stderr.contains("acceptance verification was not satisfied"));

    let requests = server.join();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].request_line,
        "POST /api/acceptance/v1/projects/project-1/reviews/review-1/verify HTTP/1.1"
    );
    assert_eq!(
        requests[0].headers.get("authorization").map(String::as_str),
        Some("Bearer test-token")
    );
    assert_eq!(
        requests[0].headers.get("idempotency-key").map(String::as_str),
        Some("acceptance:verify:review-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
}

struct MockResponse {
    status: u16,
    body: String,
}

struct MockRequest {
    request_line: String,
    headers: HashMap<String, String>,
}

struct MockServer {
    url: String,
    handle: thread::JoinHandle<Vec<MockRequest>>,
}

impl MockServer {
    fn start(responses: Vec<MockResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http_request(&mut stream);
                let response_text = format!(
                    "HTTP/1.1 {} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response.status,
                    response.body.len(),
                    response.body
                );
                stream.write_all(response_text.as_bytes()).unwrap();
                requests.push(request);
            }
            requests
        });
        Self { url, handle }
    }

    fn url(&self) -> String {
        self.url.clone()
    }

    fn join(self) -> Vec<MockRequest> {
        self.handle.join().unwrap()
    }
}

fn read_http_request(stream: &mut TcpStream) -> MockRequest {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).unwrap();
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let header_end = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4;
    let headers_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + content_length {
        let read = stream.read(&mut chunk).unwrap();
        buffer.extend_from_slice(&chunk[..read]);
    }
    MockRequest {
        request_line,
        headers,
    }
}
