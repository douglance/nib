//! Full-color terminal review UI for Nib.
//!
//! Ratatui owns layout and input. Image pixels are sent losslessly through a
//! terminal graphics protocol; character-cell approximations are deliberately
//! not provided.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{
        self, DisableFocusChange, EnableFocusChange, Event, KeyCode, KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use nib_collab::{session::Session, types::ClientType};
use nib_core::{ImageSource, NibImage};
use nib_storage::{encode_composited_png, nib_file::NibFile, ExportOptions};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Terminal,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Stdout, Write},
    path::PathBuf,
    process::Command,
    time::{Duration, SystemTime},
};

// Use an 8-bit image ID so tmux clients without the RGB feature preserve the
// placeholder foreground value instead of quantizing a 24-bit ID.
const IMAGE_ID: u32 = 42;

#[derive(Debug, Clone)]
pub struct ReviewRequest {
    pub file: PathBuf,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewResponse {
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    pub annotations: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphicsProtocol {
    KittyPlaceholder,
    KittyDirect,
    Iterm2,
}

#[derive(Debug, Clone)]
pub struct TerminalReport {
    pub protocol: GraphicsProtocol,
    pub tmux_version: Option<String>,
    pub client_tty: Option<String>,
    pub client_session: Option<String>,
    pub cell_pixels: Option<(u16, u16)>,
    pub outer_terminal: String,
    pub ssh: bool,
    pub passthrough: bool,
}

impl TerminalReport {
    pub fn detect() -> Result<Self> {
        if let Ok(forced) = std::env::var("NIB_TERMINAL_PROTOCOL") {
            let protocol = match forced.as_str() {
                "kitty" => GraphicsProtocol::KittyPlaceholder,
                "kitty-direct" => GraphicsProtocol::KittyDirect,
                "iterm2" => GraphicsProtocol::Iterm2,
                _ => bail!("E_PROTOCOL: NIB_TERMINAL_PROTOCOL must be kitty or iterm2"),
            };
            return Ok(Self {
                protocol,
                tmux_version: None,
                client_tty: None,
                client_session: None,
                cell_pixels: None,
                outer_terminal: "forced".into(),
                ssh: std::env::var_os("SSH_CONNECTION").is_some(),
                passthrough: true,
            });
        }

        let in_tmux = std::env::var_os("TMUX").is_some();
        let ssh = std::env::var_os("SSH_CONNECTION").is_some();
        if in_tmux {
            let client_tty = tmux_output(["display-message", "-p", "#{client_tty}"])?;
            let client_tty = client_tty.trim().to_string();
            let client_session = tmux_output([
                "display-message",
                "-c",
                &client_tty,
                "-p",
                "#{session_name}",
            ])?;
            let client_session = client_session.trim().to_string();
            let cell_pixels = tmux_output([
                "display-message",
                "-c",
                &client_tty,
                "-p",
                "#{client_cell_width}x#{client_cell_height}",
            ])?;
            let cell_pixels = parse_cell_pixels(&cell_pixels);
            let global_vmux = tmux_global_env("TERM_PROGRAM")
                .is_some_and(|program| program.eq_ignore_ascii_case("vmux"));
            if current_tmux_client_uses_mosh(&client_tty).unwrap_or(global_vmux) {
                bail!(
                    "E_TRANSPORT_UNSUPPORTED: vmux/mosh does not forward terminal graphics; reconnect with true SSH before using --ui terminal"
                );
            }
            let version = tmux_output(["-V"])?;
            if !tmux_at_least(&version, 3, 3) {
                bail!("E_TMUX_VERSION: {version}; Nib terminal review requires tmux 3.3+");
            }
            let passthrough = tmux_output(["show-options", "-gv", "allow-passthrough"])?;
            if passthrough.trim() != "on" && passthrough.trim() != "all" {
                bail!("E_TMUX_PASSTHROUGH: run `tmux set -g allow-passthrough on`");
            }
            let outer = tmux_output([
                "display-message",
                "-c",
                &client_tty,
                "-p",
                "#{client_termname}",
            ])?;
            let outer = outer.trim().to_lowercase();
            if outer.starts_with("tmux") || outer.starts_with("screen") {
                bail!("E_NESTED_TMUX: terminal image review supports exactly one tmux layer");
            }
            if !supports_kitty_graphics(&outer) {
                bail!("E_GRAPHICS_UNSUPPORTED: outer terminal `{outer}` did not advertise Kitty placeholder support; refusing degraded rendering");
            }
            let protocol = if outer.contains("kitty") {
                GraphicsProtocol::KittyPlaceholder
            } else {
                GraphicsProtocol::KittyDirect
            };
            return Ok(Self {
                protocol,
                tmux_version: Some(version.trim().to_string()),
                client_tty: Some(client_tty),
                client_session: Some(client_session),
                cell_pixels,
                outer_terminal: outer,
                ssh,
                passthrough: true,
            });
        }

        let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();
        let term = std::env::var("TERM").unwrap_or_default();
        let combined = format!("{} {}", term_program, term).to_lowercase();
        let protocol = if combined.contains("kitty") {
            GraphicsProtocol::KittyPlaceholder
        } else if combined.contains("ghostty") {
            GraphicsProtocol::KittyDirect
        } else if combined.contains("iterm") {
            GraphicsProtocol::Iterm2
        } else {
            bail!("E_GRAPHICS_UNSUPPORTED: terminal does not advertise Kitty or iTerm2 graphics; refusing degraded rendering");
        };
        Ok(Self {
            protocol,
            tmux_version: None,
            client_tty: None,
            client_session: None,
            cell_pixels: None,
            outer_terminal: combined.trim().to_string(),
            ssh,
            passthrough: false,
        })
    }

    pub fn status(&self) -> String {
        let protocol = match self.protocol {
            GraphicsProtocol::KittyPlaceholder => "Kitty placeholder",
            GraphicsProtocol::KittyDirect => "Kitty direct",
            GraphicsProtocol::Iterm2 => "iTerm2 inline",
        };
        match &self.tmux_version {
            Some(version) => format!(
                "{} | {} | {} | SSH {} | passthrough OK",
                protocol,
                version,
                self.outer_terminal,
                if self.ssh { "yes" } else { "no" }
            ),
            None => format!("{} | {}", protocol, self.outer_terminal),
        }
    }
}

fn supports_kitty_graphics(value: &str) -> bool {
    value.contains("kitty") || value.contains("ghostty")
}

fn parse_cell_pixels(value: &str) -> Option<(u16, u16)> {
    let (width, height) = value.trim().split_once('x')?;
    let width = width.parse().ok()?;
    let height = height.parse().ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

fn tmux_global_env(name: &str) -> Option<String> {
    let assignment = tmux_output(["show-environment", "-g", name]).ok()?;
    assignment
        .trim()
        .split_once('=')
        .map(|(_, value)| value.to_string())
}

/// Determine the transport of the tmux client that invoked this command.
///
/// A tmux server keeps global environment values from older attachments, so a
/// stale `TERM_PROGRAM=vmux` cannot identify the current client. Walking the
/// current client's process ancestry distinguishes a Mosh attachment from a
/// later direct SSH or local terminal attachment.
fn current_tmux_client_uses_mosh(client_tty: &str) -> Option<bool> {
    let client_pid: u32 = tmux_output(["display-message", "-c", client_tty, "-p", "#{client_pid}"])
        .ok()?
        .trim()
        .parse()
        .ok()?;
    process_ancestry_uses_mosh(client_pid)
}

fn process_ancestry_uses_mosh(mut pid: u32) -> Option<bool> {
    for _ in 0..16 {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "ppid=", "-o", "command="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&output.stdout);
        let mut fields = line.trim().splitn(2, char::is_whitespace);
        let parent: u32 = fields.next()?.parse().ok()?;
        let command = fields.next().unwrap_or_default().trim().to_lowercase();
        if command.contains("mosh-server") || command.contains("vmux-mosh") {
            return Some(true);
        }
        if parent <= 1 || parent == pid {
            return Some(false);
        }
        pid = parent;
    }
    None
}

fn tmux_output<const N: usize>(args: [&str; N]) -> Result<String> {
    let output = Command::new(tmux_binary())
        .args(args)
        .output()
        .context("failed to run tmux")?;
    if !output.status.success() {
        bail!(
            "tmux command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn tmux_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("NIB_TMUX_BIN") {
        return path.into();
    }
    for path in [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ] {
        if std::path::Path::new(path).is_file() {
            return path.into();
        }
    }
    "tmux".into()
}

fn tmux_at_least(version: &str, major: u32, minor: u32) -> bool {
    let numeric = version
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or("0");
    let mut parts = numeric
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty());
    let found_major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let found_minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (found_major, found_minor) >= (major, minor)
}

pub async fn run_review(request: ReviewRequest) -> Result<ReviewResponse> {
    let report = TerminalReport::detect()?;
    let nib = NibFile::open(&request.file)?;
    let (image_data, info) = nib.get_image()?;
    let image = NibImage {
        image_data,
        width: info.width,
        height: info.height,
        source: ImageSource::File(request.file.clone()),
        annotations: nib.list_annotations()?,
        assets: nib.get_all_assets()?,
        title: None,
        description: None,
        tags: Vec::new(),
        file_path: Some(request.file.clone()),
        created_at: SystemTime::now(),
        modified_at: SystemTime::now(),
    };
    let png = encode_composited_png(&image, &ExportOptions::default())?;
    let rgba = image::load_from_memory(&png)?.to_rgba8().into_raw();
    let response = ReviewApp::new(request, report, png, rgba, image.width, image.height).run()?;

    let session = Session::connect(&response.0, ClientType::Tui)
        .await
        .map_err(|e| anyhow!(e))?;
    let payload = serde_json::to_string(&response.1)?;
    session.send_to_agent(payload).map_err(|e| anyhow!(e))?;
    Ok(response.1)
}

struct ReviewApp {
    request: ReviewRequest,
    report: TerminalReport,
    png: Vec<u8>,
    rgba: Vec<u8>,
    image_width: u32,
    image_height: u32,
    comment: String,
    editing: bool,
    transmitted: bool,
    last_image_area: Option<Rect>,
}

impl ReviewApp {
    fn new(
        request: ReviewRequest,
        report: TerminalReport,
        png: Vec<u8>,
        rgba: Vec<u8>,
        image_width: u32,
        image_height: u32,
    ) -> Self {
        Self {
            request,
            report,
            png,
            rgba,
            image_width,
            image_height,
            comment: String::new(),
            editing: false,
            transmitted: false,
            last_image_area: None,
        }
    }

    fn run(mut self) -> Result<(PathBuf, ReviewResponse)> {
        let mut guard = TerminalGuard::enter(self.report.tmux_version.is_some())?;
        loop {
            let mut image_area = Rect::default();
            guard.terminal.draw(|frame| {
                let area = frame.area();
                let rows = Layout::default()
                    .direction(Direction::Vertical)
                    .constraints([
                        Constraint::Length(3),
                        Constraint::Min(6),
                        Constraint::Length(if self.editing { 5 } else { 3 }),
                        Constraint::Length(2),
                    ])
                    .split(area);
                let title = format!(" Nib review | {}x{} ", self.image_width, self.image_height);
                frame.render_widget(
                    Paragraph::new(self.report.status())
                        .block(Block::default().title(title).borders(Borders::ALL)),
                    rows[0],
                );
                image_area = rows[1].inner(ratatui::layout::Margin {
                    horizontal: 1,
                    vertical: 1,
                });
                frame.render_widget(
                    Block::default()
                        .title(" Full-quality image ")
                        .borders(Borders::ALL),
                    rows[1],
                );
                let question = self
                    .request
                    .message
                    .as_deref()
                    .unwrap_or("Review this image");
                if self.editing {
                    frame.render_widget(
                        Paragraph::new(self.comment.as_str())
                            .wrap(Wrap { trim: false })
                            .block(
                                Block::default()
                                    .title(question)
                                    .borders(Borders::ALL)
                                    .border_style(Style::default().fg(Color::Cyan)),
                            ),
                        rows[2],
                    );
                } else {
                    frame.render_widget(
                        Paragraph::new(question)
                            .wrap(Wrap { trim: true })
                            .block(Block::default().title(" Request ").borders(Borders::ALL)),
                        rows[2],
                    );
                }
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::styled(
                            "[a] approve",
                            Style::default()
                                .fg(Color::Green)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::raw("  "),
                        Span::styled(
                            "[r] reject",
                            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                        ),
                        Span::raw("  "),
                        Span::styled(
                            "[c] comment",
                            Style::default()
                                .fg(Color::Cyan)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::raw("  [q] cancel"),
                    ])),
                    rows[3],
                );
            })?;

            self.draw_image(image_area)?;
            if event::poll(Duration::from_millis(100))? {
                match event::read()? {
                    Event::FocusLost | Event::FocusGained => {
                        self.delete_image()?;
                        self.transmitted = false;
                    }
                    Event::Key(key) => {
                        if key.kind != KeyEventKind::Press {
                            continue;
                        }
                        if self.editing {
                            match key.code {
                                KeyCode::Esc => self.editing = false,
                                KeyCode::Enter if !self.comment.trim().is_empty() => {
                                    return Ok((
                                        self.request.file,
                                        response("comment", Some(self.comment.trim().to_string())),
                                    ))
                                }
                                KeyCode::Backspace => {
                                    self.comment.pop();
                                }
                                KeyCode::Char(ch)
                                    if !key.modifiers.contains(KeyModifiers::CONTROL) =>
                                {
                                    self.comment.push(ch)
                                }
                                _ => {}
                            }
                        } else {
                            match key.code {
                                KeyCode::Char('a') => {
                                    return Ok((self.request.file, response("approve", None)))
                                }
                                KeyCode::Char('r') => {
                                    return Ok((self.request.file, response("reject", None)))
                                }
                                KeyCode::Char('c') => self.editing = true,
                                KeyCode::Char('q') | KeyCode::Esc => bail!("review cancelled"),
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn draw_image(&mut self, area: Rect) -> Result<()> {
        if area.width == 0 || area.height == 0 {
            return Ok(());
        }
        if self.last_image_area != Some(area) {
            self.delete_image()?;
            self.transmitted = false;
            self.last_image_area = Some(area);
        }
        let mut out = io::stdout();
        match self.report.protocol {
            GraphicsProtocol::KittyPlaceholder => {
                if !self.transmitted {
                    let sequence = kitty_transmit_inner(
                        &self.rgba,
                        IMAGE_ID,
                        area.width,
                        area.height,
                        self.image_width,
                        self.image_height,
                        self.report.tmux_version.is_some(),
                    );
                    write!(out, "{sequence}")?;
                    self.transmitted = true;
                }
                for row in 0..area.height.min(DIACRITICS.len() as u16) {
                    execute!(out, MoveTo(area.x, area.y + row))?;
                    write!(
                        out,
                        "\x1b[38;5;{}m\u{10EEEE}{}{}",
                        IMAGE_ID, DIACRITICS[row as usize], DIACRITICS[0]
                    )?;
                    for _ in 1..area.width {
                        write!(out, "\u{10EEEE}")?;
                    }
                    write!(out, "\x1b[39m")?;
                }
            }
            GraphicsProtocol::KittyDirect => {
                let placement = direct_placement(
                    area,
                    self.image_width,
                    self.image_height,
                    self.report.cell_pixels.unwrap_or((1, 2)),
                );
                execute!(out, MoveTo(placement.x, placement.y))?;
                if !self.transmitted {
                    let sequence = kitty_transmit_direct(
                        &self.png,
                        IMAGE_ID,
                        placement,
                        self.report.tmux_version.is_some(),
                    );
                    write!(out, "{sequence}")?;
                    self.transmitted = true;
                }
            }
            GraphicsProtocol::Iterm2 => {
                if !self.transmitted {
                    execute!(out, MoveTo(area.x, area.y))?;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&self.png);
                    write!(out, "\x1b]1337;File=inline=1;width={};height={};preserveAspectRatio=1;doNotMoveCursor=1:{}\x07", area.width, area.height, encoded)?;
                    self.transmitted = true;
                }
            }
        }
        out.flush()?;
        Ok(())
    }

    fn delete_image(&self) -> Result<()> {
        if !self.transmitted {
            return Ok(());
        }
        let sequence = format!("\x1b_Ga=d,d=I,i={},q=2\x1b\\", IMAGE_ID);
        let mut out = io::stdout();
        write!(
            out,
            "{}",
            if self.report.tmux_version.is_some() {
                tmux_wrap(&sequence)
            } else {
                sequence
            }
        )?;
        out.flush()?;
        Ok(())
    }
}

fn response(decision: &str, comment: Option<String>) -> ReviewResponse {
    ReviewResponse {
        decision: decision.into(),
        comment,
        annotations: Vec::new(),
    }
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    in_tmux: bool,
}
impl TerminalGuard {
    fn enter(in_tmux: bool) -> Result<Self> {
        enable_raw_mode()?;
        let mut out = io::stdout();
        execute!(out, EnterAlternateScreen, EnableFocusChange, Hide)?;
        let terminal = Terminal::new(CrosstermBackend::new(out))?;
        Ok(Self { terminal, in_tmux })
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let mut out = io::stdout();
        let delete = format!("\x1b_Ga=d,d=I,i={},q=2\x1b\\", IMAGE_ID);
        let delete = if self.in_tmux {
            tmux_wrap(&delete)
        } else {
            delete
        };
        let _ = write!(out, "{delete}");
        let _ = execute!(out, Show, DisableFocusChange, LeaveAlternateScreen);
        let _ = disable_raw_mode();
    }
}

pub fn kitty_transmit(
    rgba: &[u8],
    image_id: u32,
    cols: u16,
    rows: u16,
    width: u32,
    height: u32,
) -> String {
    kitty_transmit_inner(rgba, image_id, cols, rows, width, height, false)
}

fn kitty_transmit_inner(
    rgba: &[u8],
    image_id: u32,
    cols: u16,
    rows: u16,
    width: u32,
    height: u32,
    in_tmux: bool,
) -> String {
    let chunks: Vec<&[u8]> = rgba.chunks(3072).collect();
    let mut result = String::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let more = usize::from(index + 1 < chunks.len());
        let mut command = String::new();
        if index == 0 {
            command.push_str(&format!(
                "\x1b_Ga=T,f=32,t=d,U=1,i={image_id},s={width},v={height},c={cols},r={rows},q=2,m={more};"
            ));
        } else {
            command.push_str(&format!("\x1b_Gm={more};"));
        }
        command.push_str(&base64::engine::general_purpose::STANDARD.encode(chunk));
        command.push_str("\x1b\\");
        result.push_str(&if in_tmux {
            tmux_wrap(&command)
        } else {
            command
        });
    }
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectPlacement {
    x: u16,
    y: u16,
    cols: Option<u16>,
    rows: Option<u16>,
}

fn direct_placement(
    area: Rect,
    image_width: u32,
    image_height: u32,
    cell_pixels: (u16, u16),
) -> DirectPlacement {
    let (cell_width, cell_height) = cell_pixels;
    let image_aspect = image_width as f64 / image_height.max(1) as f64;
    let available_aspect =
        area.width as f64 * cell_width as f64 / (area.height.max(1) as f64 * cell_height as f64);
    if image_aspect >= available_aspect {
        let rows = ((area.width as f64 * cell_width as f64 / image_aspect) / cell_height as f64)
            .ceil()
            .max(1.0) as u16;
        DirectPlacement {
            x: area.x,
            y: area.y + area.height.saturating_sub(rows.min(area.height)) / 2,
            cols: Some(area.width),
            rows: None,
        }
    } else {
        let cols = ((area.height as f64 * cell_height as f64 * image_aspect) / cell_width as f64)
            .ceil()
            .max(1.0) as u16;
        DirectPlacement {
            x: area.x + area.width.saturating_sub(cols.min(area.width)) / 2,
            y: area.y,
            cols: None,
            rows: Some(area.height),
        }
    }
}

fn placement_fields(placement: DirectPlacement) -> String {
    match (placement.cols, placement.rows) {
        (Some(cols), None) => format!("c={cols}"),
        (None, Some(rows)) => format!("r={rows}"),
        _ => unreachable!("direct placement must constrain exactly one dimension"),
    }
}

fn kitty_transmit_direct(
    png: &[u8],
    image_id: u32,
    placement: DirectPlacement,
    in_tmux: bool,
) -> String {
    let chunks: Vec<&[u8]> = png.chunks(3072).collect();
    let mut result = String::new();
    let geometry = placement_fields(placement);
    for (index, chunk) in chunks.iter().enumerate() {
        let more = usize::from(index + 1 < chunks.len());
        let mut command = String::new();
        if index == 0 {
            command.push_str(&format!(
                "\x1b_Ga=T,f=100,t=d,i={image_id},p=1,{geometry},C=1,q=2,m={more};"
            ));
        } else {
            command.push_str(&format!("\x1b_Gm={more};"));
        }
        command.push_str(&base64::engine::general_purpose::STANDARD.encode(chunk));
        command.push_str("\x1b\\");
        result.push_str(&if in_tmux {
            tmux_wrap(&command)
        } else {
            command
        });
    }
    result
}

pub fn tmux_wrap(sequence: &str) -> String {
    format!("\x1bPtmux;{}\x1b\\", sequence.replace('\x1b', "\x1b\x1b"))
}

static DIACRITICS: &[char] = &[
    '\u{305}', '\u{30D}', '\u{30E}', '\u{310}', '\u{312}', '\u{33D}', '\u{33E}', '\u{33F}',
    '\u{346}', '\u{34A}', '\u{34B}', '\u{34C}', '\u{350}', '\u{351}', '\u{352}', '\u{357}',
    '\u{35B}', '\u{363}', '\u{364}', '\u{365}', '\u{366}', '\u{367}', '\u{368}', '\u{369}',
    '\u{36A}', '\u{36B}', '\u{36C}', '\u{36D}', '\u{36E}', '\u{36F}', '\u{483}', '\u{484}',
    '\u{485}', '\u{486}', '\u{487}', '\u{592}', '\u{593}', '\u{594}', '\u{595}', '\u{597}',
    '\u{598}', '\u{599}', '\u{59C}', '\u{59D}', '\u{59E}', '\u{59F}', '\u{5A0}', '\u{5A1}',
    '\u{5A8}', '\u{5A9}', '\u{5AB}', '\u{5AC}', '\u{5AF}', '\u{5C4}', '\u{610}', '\u{611}',
    '\u{612}', '\u{613}', '\u{614}', '\u{615}', '\u{616}', '\u{617}', '\u{657}', '\u{658}',
    '\u{659}', '\u{65A}', '\u{65B}', '\u{65D}', '\u{65E}', '\u{6D6}', '\u{6D7}', '\u{6D8}',
    '\u{6D9}', '\u{6DA}', '\u{6DB}', '\u{6DC}', '\u{6DF}', '\u{6E0}', '\u{6E1}', '\u{6E2}',
    '\u{6E4}', '\u{6E7}', '\u{6E8}', '\u{6EB}', '\u{6EC}', '\u{730}', '\u{732}', '\u{733}',
    '\u{735}', '\u{736}', '\u{73A}', '\u{73D}', '\u{73F}', '\u{740}', '\u{741}', '\u{743}',
    '\u{745}', '\u{747}',
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kitty_payload_is_chunked_and_lossless() {
        let rgba = vec![7_u8; 5000];
        let sequence = kitty_transmit(&rgba, 42, 80, 24, 50, 25);
        assert!(sequence.contains("a=T,f=32,t=d,U=1,i=42,s=50,v=25,c=80,r=24,q=2,m=1"));
        assert!(sequence.contains("\x1b_Gm=0;"));
        let encoded: String = sequence
            .split("\x1b_G")
            .skip(1)
            .filter_map(|chunk| {
                chunk
                    .split_once(';')
                    .map(|(_, payload)| payload.trim_end_matches("\x1b\\"))
            })
            .collect();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            rgba
        );
    }

    #[test]
    fn tmux_passthrough_doubles_inner_escape() {
        assert_eq!(
            tmux_wrap("\x1b_Gx\x1b\\"),
            "\x1bPtmux;\x1b\x1b_Gx\x1b\x1b\\\x1b\\"
        );
    }

    #[test]
    fn tmux_wraps_each_kitty_chunk_separately() {
        let sequence = kitty_transmit_inner(&vec![1_u8; 5000], 42, 80, 24, 50, 25, true);
        assert!(sequence.matches("\x1bPtmux;").count() >= 2);
    }

    #[test]
    fn ghostty_direct_placement_does_not_use_placeholders() {
        let placement = DirectPlacement {
            x: 0,
            y: 0,
            cols: Some(80),
            rows: None,
        };
        let sequence = kitty_transmit_direct(&vec![1_u8; 5000], 42, placement, true);
        assert!(sequence.contains("a=T,f=100,t=d,i=42,p=1,c=80,C=1"));
        assert!(!sequence.contains(",r="));
        assert!(!sequence.contains("U=1"));
    }

    #[test]
    fn direct_placement_preserves_aspect_ratio_in_terminal_pixels() {
        let wide_terminal = Rect::new(0, 0, 200, 50);
        let placement = direct_placement(wide_terminal, 1440, 900, (19, 42));
        assert_eq!(placement.cols, None);
        assert_eq!(placement.rows, Some(50));
        assert!(placement.x > 0);

        let narrow_terminal = Rect::new(0, 0, 60, 50);
        let placement = direct_placement(narrow_terminal, 1440, 900, (19, 42));
        assert_eq!(placement.cols, Some(60));
        assert_eq!(placement.rows, None);
        assert!(placement.y > 0);
    }

    #[test]
    fn versions_are_compared_numerically() {
        assert!(tmux_at_least("tmux 3.5a", 3, 3));
        assert!(!tmux_at_least("tmux 3.2", 3, 3));
    }

    #[test]
    fn vmux_is_not_misidentified_as_a_graphics_terminal() {
        assert!(!supports_kitty_graphics("vmux xterm-256color"));
    }

    #[test]
    fn response_contract_matches_gui() {
        assert_eq!(
            serde_json::to_value(response("approve", None)).unwrap(),
            serde_json::json!({"decision":"approve","annotations":[]})
        );
    }
}
