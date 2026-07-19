# Feedback Surface

Use for the HTML UI inside the nib viewer chrome that collects feedback about a target website or artifact.

Build one complete HTML document with inline CSS and small vanilla JavaScript. The page is rendered in a sandboxed iframe, separate from the reviewed target iframe. Nib injects `window.nib.feedback` into that iframe before your code runs.

Preferred bridge:

- Call `window.nib.feedback.ready()` after initialization.
- Submit with `window.nib.feedback.submit({ kind, text, choice, data })`.
- Optional capture button: `window.nib.feedback.capture()`.
- Optional resize: `window.nib.feedback.resize(height)`.

Raw `postMessage` with the same `nib.feedback.*` message types still works for compatibility.

Prefer direct controls that answer the question: choices, sliders, rating buttons, short structured fields, annotation toggles, and a freeform note. Keep the surface compact enough for the bottom drawer.
