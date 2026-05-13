# Feedback Surface

Use for the HTML UI inside the prtl viewer chrome that collects feedback about a target website or artifact.

Build one complete HTML document with inline CSS and small vanilla JavaScript. The page is rendered in a sandboxed iframe, separate from the reviewed target iframe. Prtl injects `window.prtl.feedback` into that iframe before your code runs.

Preferred bridge:

- Call `window.prtl.feedback.ready()` after initialization.
- Submit with `window.prtl.feedback.submit({ kind, text, choice, data })`.
- Optional capture button: `window.prtl.feedback.capture()`.
- Optional resize: `window.prtl.feedback.resize(height)`.

Raw `postMessage` with the same `prtl.feedback.*` message types still works for compatibility.

Prefer direct controls that answer the question: choices, sliders, rating buttons, short structured fields, annotation toggles, and a freeform note. Keep the surface compact enough for the bottom drawer.
