# Feedback Loop V2 Implementation Plan

## Overview

Tighten the Claude-human feedback loop in Nib by making `nib feedback` a single command that handles GUI spawning, message display, and annotation collection. The goal: Claude runs one command and gets structured feedback from a human annotator.

## Success Criteria

- [ ] `nib feedback image.nib -m "where should the button go?"` works end-to-end
- [ ] If GUI already running for this file, CLI just connects (no new window)
- [ ] Message displays as persistent toast in GUI until human responds
- [ ] Cmd+Enter sends annotations and keeps GUI open
- [ ] Shift+Cmd+Enter sends annotations and quits GUI
- [ ] CLI receives JSON payload and exits
- [ ] All tests pass, builds succeed

## Technical Approach

The current architecture has most pieces in place. The collab system already supports GUI-CLI communication via Unix sockets. The key insight is: **use the existing IPC for message delivery** rather than the SQLite-based `add_message()` polling. This gives real-time message display.

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Toast behavior | Replace (show latest only) | Claude asks one question at a time; stacking creates visual noise |
| Message transport | Collab IPC (socket) | Real-time delivery vs polling; already handles connection management |
| GUI detection | Try `Session::connect()` first | Socket existence + connection success = GUI running |
| Process lifecycle | Independent | GUI outlives CLI; no tracking needed |
| Quit signal | New `CollabMessage::RequestQuit` | Clean shutdown via IPC rather than process signals |

### Rejected Alternatives

1. **SQLite message polling**: Works but adds 100ms+ latency and requires render activity
2. **Process signals (SIGTERM)**: Unreliable, no graceful shutdown
3. **Toast stacking**: Adds complexity, Claude only asks one thing at a time

## Implementation Phases

### Phase 1: Extend CollabMessage Protocol (est: 30min)

**Goal**: Add message types for CLI-to-GUI communication

**Pre-conditions**:
- Codebase compiles cleanly

**Steps**:

1. [ ] Add new variants to `CollabMessage` enum in `src/collab/types.rs`:

```rust
// Add to CollabMessage enum
/// Display a message in GUI (persistent question toast)
ShowMessage {
    message: String,
    /// "claude" | "system" | "user"
    source: String,
},

/// Request GUI to quit gracefully
RequestQuit {
    /// Client requesting the quit
    client_id: ClientId,
},
```

2. [ ] Update `CollabServer::process_message()` in `src/collab/ipc.rs` to handle new message types:

```rust
CollabMessage::ShowMessage { message, source } => {
    // Broadcast to all clients (GUI will display, CLI ignores)
    let _ = self.broadcast_tx.send(CollabMessage::ShowMessage {
        message: message.clone(),
        source: source.clone()
    });
    None // No response needed
}

CollabMessage::RequestQuit { client_id } => {
    // Broadcast quit request to all clients
    let _ = self.broadcast_tx.send(CollabMessage::RequestQuit { client_id });
    None
}
```

3. [ ] Add helper method to `Session` in `src/collab/session.rs`:

```rust
/// Send a message to be displayed in GUI
pub fn send_message(&self, message: String, source: &str) -> Result<(), String> {
    let handle = self.handle.as_ref().ok_or("No session handle")?;
    handle.sender
        .send(CollabMessage::ShowMessage {
            message,
            source: source.to_string()
        })
        .map_err(|e| format!("Failed to send message: {}", e))
}

/// Request GUI to quit
pub fn request_quit(&self) -> Result<(), String> {
    let handle = self.handle.as_ref().ok_or("No session handle")?;
    handle.sender
        .send(CollabMessage::RequestQuit {
            client_id: handle.client_id
        })
        .map_err(|e| format!("Failed to request quit: {}", e))
}
```

**Verification**:
```bash
cargo check
cargo test collab
```

**Rollback**: Revert changes to types.rs, ipc.rs, session.rs

---

### Phase 2: Update CLI Feedback Command (est: 45min)

**Goal**: Add `-m` flag and idempotent GUI handling

**Pre-conditions**:
- Phase 1 complete

**Steps**:

1. [ ] Add message flag to `FeedbackArgs` in `src/cli/args.rs`:

```rust
#[derive(Parser, Debug)]
pub struct FeedbackArgs {
    /// Image or .nib file to get feedback on
    pub file: PathBuf,

    /// Message to display in GUI (question for human)
    #[arg(short = 'm', long)]
    pub message: Option<String>,

    /// Timeout in seconds (default: 60, 0 = no timeout)
    #[arg(short = 't', long, default_value = "60")]
    pub timeout: u64,

    /// Don't auto-open GUI (use when GUI is already open)
    #[arg(long)]
    pub no_gui: bool,

    /// Don't auto-render after annotation detected
    #[arg(long)]
    pub no_render: bool,
}
```

2. [ ] Refactor `run_feedback()` in `src/cli/commands.rs` to:
   - Try `Session::connect()` first to detect existing GUI
   - Only spawn GUI if connection fails
   - Send message via collab after connection established
   - Remove the 500ms sleep (connection retry loop instead)

```rust
pub async fn run_feedback(args: &super::args::FeedbackArgs) -> Result<()> {
    // ... existing file validation and .nib conversion ...

    // Try to connect to existing GUI first
    let mut session = match Session::connect(&nib_path, ClientType::Cli).await {
        Ok(s) => {
            tracing::info!("Connected to existing GUI session");
            s
        }
        Err(_) => {
            // No GUI running, spawn one if not --no-gui
            if args.no_gui {
                return Err(NibError::Other(
                    "No GUI running and --no-gui specified".into()
                ));
            }

            // Spawn GUI subprocess
            let exe_path = std::env::current_exe()?;
            let _child = std::process::Command::new(&exe_path)
                .arg("gui")
                .arg(&nib_path)
                .spawn()?;

            // Wait for GUI to start and create session (with retries)
            let mut attempts = 0;
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                match Session::connect(&nib_path, ClientType::Cli).await {
                    Ok(s) => break s,
                    Err(e) if attempts < 25 => { // 5 seconds total
                        attempts += 1;
                        continue;
                    }
                    Err(e) => return Err(NibError::Other(
                        format!("Failed to connect to GUI: {}", e)
                    )),
                }
            }
        }
    };

    // Send message if provided
    if let Some(ref message) = args.message {
        session.send_message(message.clone(), "claude")?;
    }

    // Wait for SendToAgent (unchanged logic)
    // ...
}
```

**Verification**:
```bash
cargo build
# Test 1: GUI not running
nib feedback test.nib -m "Test message" -t 5
# Test 2: GUI already running (in another terminal, start nib gui test.nib first)
nib feedback test.nib -m "Another message"
```

**Rollback**: Revert args.rs and commands.rs changes

---

### Phase 3: GUI Persistent Question Toast (est: 1h)

**Goal**: Display Claude's question as a persistent toast that stays until human responds

**Pre-conditions**:
- Phase 1 complete

**Steps**:

1. [ ] Add new field to `EditorView` in `src/gui/app.rs`:

```rust
/// Persistent question from Claude (stays until Send pressed)
claude_question: Option<String>,
```

2. [ ] Initialize in `EditorView::new()`:

```rust
claude_question: None,
```

3. [ ] Add method to handle incoming collab messages. Modify the collab session message processing:

```rust
/// Process messages from collab session (call from render loop)
fn process_collab_messages(&mut self, cx: &mut Context<Self>) {
    let Some(ref session) = self.collab_session else { return };

    // Try to receive messages without blocking
    while let Ok(msg) = session.handle.as_ref()
        .map(|h| h.receiver.try_recv())
        .transpose()
        .ok()
        .flatten()
    {
        match msg {
            CollabMessage::ShowMessage { message, source } => {
                if source == "claude" {
                    self.claude_question = Some(message);
                    cx.notify();
                } else {
                    self.add_toast(message, cx);
                }
            }
            CollabMessage::RequestQuit { .. } => {
                // Clean shutdown requested
                std::process::exit(0);
            }
            CollabMessage::Operation(op) => {
                // Apply annotation operations (existing logic)
                apply_operation(&mut self.annotations, &op.operation);
                cx.notify();
            }
            _ => {}
        }
    }
}
```

4. [ ] Render the persistent question toast. Add new render method:

```rust
/// Render persistent Claude question (different from ephemeral toasts)
fn render_question(&self) -> impl IntoElement {
    let Some(ref question) = self.claude_question else {
        return div();
    };

    div()
        .absolute()
        .top_4()
        .left_1_2()  // Centered horizontally
        .neg_translate_x_1_2()
        .max_w(px(500.))
        .px_4()
        .py_3()
        .rounded_lg()
        .bg(rgba(0x1a1a1aee))
        .border_1()
        .border_color(rgb(0x3b82f6))  // Blue border for Claude
        .shadow_lg()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .text_color(rgb(0x93c5fd))
                .text_size(px(11.))
                .child("Claude asks:")
        )
        .child(
            div()
                .text_color(rgb(0xffffff))
                .text_size(px(14.))
                .child(question.clone())
        )
        .child(
            div()
                .text_color(rgb(0x9ca3af))
                .text_size(px(11.))
                .child("Press Cmd+Enter to respond")
        )
}
```

5. [ ] Add to render tree in `render()` method (near toast rendering):

```rust
.child(self.render_question())
.child(self.render_toasts())
```

6. [ ] Clear question when sending annotations. Modify `send_to_claude()`:

```rust
fn send_to_claude(&mut self, cx: &mut Context<Self>) {
    // ... existing delta computation and send logic ...

    // Clear the question after successful send
    self.claude_question = None;

    // ... rest of method ...
}
```

7. [ ] Call `process_collab_messages()` from render loop. Add to the check_and_reload_annotations or a similar polling location:

```rust
// In render() or a dedicated polling method called from render
self.process_collab_messages(cx);
```

**Verification**:
```bash
cargo build
# Start GUI, then in another terminal:
nib feedback test.nib -m "Where should the button go?"
# Verify: Question appears centered at top
# Click somewhere, then Cmd+Enter
# Verify: Question disappears, CLI receives JSON
```

**Rollback**: Revert gui/app.rs changes

---

### Phase 4: Keyboard Shortcuts (est: 30min)

**Goal**: Implement Cmd+Enter (send) and Shift+Cmd+Enter (send+quit)

**Pre-conditions**:
- Phase 3 complete

**Steps**:

1. [ ] Update `handle_key_down()` in `src/gui/app.rs` to distinguish shortcuts:

```rust
// Handle Cmd+Enter to send to Claude
if keystroke.modifiers.platform && keystroke.key.as_str() == "enter" {
    let quit_after = keystroke.modifiers.shift;
    self.send_to_claude(cx);

    if quit_after {
        // Give a moment for the send to complete
        cx.spawn(|_, _| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            std::process::exit(0);
        }).detach();
    }
    return;
}
```

2. [ ] Update the question tooltip text in `render_question()`:

```rust
.child(
    div()
        .text_color(rgb(0x9ca3af))
        .text_size(px(11.))
        .child("Cmd+Enter to respond | Shift+Cmd+Enter to respond & quit")
)
```

**Verification**:
```bash
cargo build
# Test Cmd+Enter: GUI stays open
# Test Shift+Cmd+Enter: GUI closes after send
```

**Rollback**: Revert handle_key_down changes

---

### Phase 5: Polish and Edge Cases (est: 30min)

**Goal**: Handle edge cases and improve reliability

**Pre-conditions**:
- Phases 1-4 complete

**Steps**:

1. [ ] Handle CLI disconnect gracefully in GUI:
   - If CLI disconnects while question is displayed, keep question visible
   - New CLI connection should work seamlessly

2. [ ] Add timeout handling improvement in CLI:
   - On timeout, output `{"event": "timeout", "question": "<original question>"}` so Claude knows what was asked

3. [ ] Persist question in NibFile as backup:
   - Use existing `add_message()` alongside collab for crash recovery
   - On GUI restart, load pending question from messages table

4. [ ] Add `--wait` flag as alias for long timeout:
   - `nib feedback file.nib -m "question" --wait` implies timeout=3600

**Verification**:
```bash
cargo test
cargo build
# Integration test: full workflow
```

**Rollback**: Individual change reverts

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Socket race condition on GUI startup | Medium | Medium | Retry loop with backoff |
| Message lost if GUI crashes | Low | High | Persist to NibFile as backup |
| GPUI doesn't like collab receiver in render | Medium | High | Use channel polling, not blocking |
| Shift key detection unreliable | Low | Low | Test on actual hardware |

## Dependencies

- GPUI (existing)
- tokio (existing)
- crossbeam-channel (existing)

## Out of Scope

- Claude responding with annotations (future: `--annotation` flag)
- Multiple simultaneous questions (stacking toasts)
- Question history/undo
- Rich text in questions (markdown rendering)
- Sound/notification on question arrival

## Testing Approach

### Unit Tests
- `CollabMessage` serialization roundtrip for new variants
- `Session::send_message()` success/failure paths

### Integration Tests
- CLI spawns GUI, sends message, receives response
- CLI connects to existing GUI
- Timeout behavior with question echo

### Manual Tests
1. Fresh start: `nib feedback new.nib -m "test"`
2. Reconnection: GUI open, run feedback command
3. Keyboard shortcuts: both variants
4. Timeout: let it expire, check output format

## File Changes Summary

| File | Changes |
|------|---------|
| `src/collab/types.rs` | Add `ShowMessage`, `RequestQuit` variants |
| `src/collab/ipc.rs` | Handle new message types in `process_message()` |
| `src/collab/session.rs` | Add `send_message()`, `request_quit()` methods |
| `src/cli/args.rs` | Add `-m/--message` flag to FeedbackArgs |
| `src/cli/commands.rs` | Refactor `run_feedback()` for idempotent GUI |
| `src/gui/app.rs` | Add question toast, keyboard shortcuts, collab message processing |
