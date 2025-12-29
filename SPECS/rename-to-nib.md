# Rename: quill → nib

## Overview

Rename the project from "quill" to "nib" - the precise point where intention meets surface.

**Scope**: Names only. No format changes, no new features.

## Phase 1: Directory & Config

```bash
# Clean first
cargo clean
rm Cargo.lock

# Rename directory
mv quill nib
```

**Cargo.toml**:
```toml
name = "nib"           # line 2
name = "nib"           # line 12 (binary)
name = "nib"           # line 16 (library)
```

## Phase 2: Type Renames

| Current | New | Files |
|---------|-----|-------|
| `QuillImage` | `NibImage` | 10 files |
| `QuillError` | `NibError` | 5 files |
| `QuillApp` | `NibApp` | 3 files |
| `QuillPoint` | `NibPoint` | 1 file |

### Key files:
- `src/core/types.rs` - `QuillImage` struct
- `src/core/errors.rs` - `QuillError` enum
- `src/gui/app.rs` - `QuillApp` struct, `QuillPoint` alias
- `src/lib.rs` - re-exports

## Phase 3: CLI & Binary

**src/cli/args.rs**:
```rust
/// Nib - Fast, native screenshot annotation tool
#[command(name = "nib")]
```

**src/main.rs**:
```rust
use nib::cli::{self, Cli, Command};
use nib::core::Result;
use nib::storage;

// Log filter
"nib=debug"
"nib=info"
```

## Phase 4: Storage Paths

| File | Change |
|------|--------|
| `src/storage/mod.rs` | `.join("nib")`, `nib.db` |
| `src/collab/log.rs` | `.join("nib")` |
| `src/ocr/mod.rs` | `.join("nib")` |
| `src/capture/tiled.rs` | `NIB_TILE_CACHE_SIZE` env var |

## Phase 5: User-Visible Strings

- `src/gui/app.rs`: "Nib Screenshot Annotator", "nib gui <file>"
- `src/cli/commands.rs`: All help text, output messages
- Filename format: `nib_{timestamp}.png`

## Phase 6: Documentation

| File | Action |
|------|--------|
| `CLAUDE.md` | Replace "quill"→"nib", "Quill"→"Nib" |
| `.claude/skills/using-quill/` | Rename to `.claude/skills/using-nib/` |
| `.claude/skills/using-nib/SKILL.md` | Update all references |
| `SPECS/*.md` | Update references |

## Phase 7: Tests

- `tests/integration_tiled_capture.rs`: Update imports

## QML Decision

**Keep "QML" as-is** - it's a format name. Can retronym to "Quick Markup Language" if needed, but no code changes required.

## Execution

```bash
# 1. Clean
cd /Users/douglance/Developer/lv/prompt2000/quill
cargo clean && rm Cargo.lock

# 2. Do all renames (use sed/replace tool)

# 3. Rename directory last
cd ..
mv quill nib

# 4. Verify
cd nib
cargo build
cargo test
cargo clippy
```

## Verification Checklist

- [ ] `cargo build` succeeds
- [ ] `cargo test` passes
- [ ] `./target/debug/nib --help` shows "nib"
- [ ] `nib capture` creates `nib_*.png`
- [ ] No "quill" in `grep -ri quill src/`
