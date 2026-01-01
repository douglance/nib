# CLI Command Consolidation Plan

## Current State: 28 Commands

Too many commands with overlapping functionality. Commands designed for Claude lack semantic clarity.

## Target State: 15 Commands

Remove duplication. Rename for intuitive AI comprehension.

---

## Phase 1: Annotation Subcommands

**Before (4 commands):**
- `add-annotation`
- `remove-annotation`
- `clear-annotations`
- `annotations`

**After (1 command with subcommands):**
```
nib annotation add <file> -t <type> [options]
nib annotation remove <file> <id>
nib annotation clear <file>
nib annotation list <file> [--since=<timestamp>]
```

**Migration:**
- Deprecate old commands with warning pointing to new syntax
- Remove old commands in next minor version

---

## Phase 2: Rename Watch → Await

**Before (2 commands):**
- Default mode: `nib <file>` (auto-converts images, blocks until annotation)
- `watch`: `nib watch <file>` (requires .nib, has --stream)

**Problem:** "watch" suggests continuous monitoring. Reality: blocks waiting for an event.

**After (1 command):**
```
nib await <file> [--stream] [--timeout=N] [--json]
```

- Semantic: "await" = wait for a specific event to occur
- Auto-converts images to .nib
- Default: block until first annotation event, then return
- `--stream`: continuous output until timeout/ctrl-c
- Remove default mode entirely

**Breaking Change:** `nib <file>` no longer works. Users must use `nib await <file>`.

---

## Phase 3: Simplify GUI Entry + Rename Feedback

**Before (5 commands):**
- `gui` - Open GUI with optional file
- `annotate` - Open GUI OR add headless annotations
- `open` - Import image to .nib and open in GUI
- `edit` - Collaborative editing with optional GUI
- `feedback` - Spawn GUI, wait for human, return

**Problem:** "feedback" is vague. Feedback on what? To whom?

**After (2 commands):**
```
nib gui <file> [--create] [--await]
nib ask-human <file> [--timeout=N] [--message=MSG] [--quit-after=N]
```

**Consolidation:**
- `gui` absorbs `open` (use `--create` to import)
- `gui` absorbs `annotate` GUI mode
- `gui --await` absorbs `edit --watch` (await human annotation)
- `annotate` headless mode → `nib annotation add`
- `feedback` → `ask-human` (semantic: request human input)

**Semantic clarity:**
- `ask-human` = I'm asking a human to annotate something
- The human responds by adding annotations
- Command returns when human has responded

---

## Phase 4: Tile Subcommands

**Before (3 commands):**
- `query` - Query tiled capture for point/region
- `extract` - Extract region at full resolution
- `tiles` - List tiles at zoom level

**After (1 command with subcommands):**
```
nib tile query <file> [--point=X,Y] [--region=X,Y,W,H]
nib tile extract <file> --region=X,Y,W,H [--output=FILE]
nib tile list <file> [--zoom=N]
```

---

## Phase 5: Keep Render Separate (No Change)

**Before (2 commands):**
- `render` - Bake annotations onto PNG
- `export` - Export .nib to PNG/JSON/QML

**Analysis:** These are semantically distinct.
- `render` = create visual output (bake annotations into image)
- `export` = extract data from format

**Decision:** Keep both. Clear semantic distinction.

```
nib render <file> [--output=FILE]     # Bake annotations → image
nib export <file> --format=json|qml   # Extract data
```

---

## Phase 6: Import Consolidation

**Before (3 commands):**
- `import` - Create .nib from image (headless)
- `open` - Create .nib and open GUI
- `migrate` - Convert sidecar JSON to .nib

**After (1 command):**
```
nib import <file> [--output=FILE] [--migrate-sidecar]
```

- `open` → `nib gui <file> --create`
- `migrate` → `nib import --migrate-sidecar`

---

## Final Command List (15 commands)

| Command | Semantic Meaning |
|---------|------------------|
| `capture` | Take a screenshot |
| `gui` | Open the graphical editor |
| `await` | Wait for annotation event |
| `ask-human` | Request human annotation |
| `annotation add` | Add annotation (headless) |
| `annotation remove` | Remove annotation by ID |
| `annotation clear` | Clear all annotations |
| `annotation list` | List annotations |
| `tile query` | Query point/region in tiled capture |
| `tile extract` | Extract region from tiled capture |
| `tile list` | List tiles at zoom level |
| `import` | Convert image → .nib |
| `render` | Bake annotations → image |
| `export` | Extract data from .nib |
| `find-text` | OCR text search |
| `grid` | Coordinate overlay |
| `info` | Show file metadata |
| `validate` | Check QML syntax |
| `list` | List recent captures |
| `folder` | Open storage folder |
| `sessions` | List active sessions |
| `mcp-server` | Start MCP server |

**Removed entirely:**
- `read` → use `annotation list --format=qml` or `export --format=qml`
- `open` → use `gui --create`
- `annotate` → split into `gui` and `annotation add`
- `edit` → use `gui --await`
- `feedback` → renamed to `ask-human`
- `watch` → renamed to `await`
- Default mode (`nib <file>`) → use `await`

---

## Implementation Order

1. **Phase 1**: Annotation subcommands (low risk, clear benefit)
2. **Phase 2**: `watch` → `await` (medium risk, semantic fix)
3. **Phase 3**: GUI simplification + `feedback` → `ask-human` (higher risk)
4. **Phase 4**: Tile subcommands (low risk, niche feature)
5. **Phase 5**: Keep render/export separate (no change needed)
6. **Phase 6**: Import consolidation (low risk)

---

## Deprecation Strategy

For each removed command:
1. Keep old command working but print deprecation warning
2. Warning includes exact new syntax to use
3. Remove after 1 minor version

Example warning:
```
DEPRECATED: 'add-annotation' will be removed in v0.3.0
Use instead: nib annotation add <file> [options]
```
