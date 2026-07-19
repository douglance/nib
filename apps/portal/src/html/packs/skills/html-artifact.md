# HTML Artifact Rules

Prtl does not generate HTML. It wraps existing HTML in a chrome that provides libraries, validation, screenshots, editable review, and a feedback bridge back to the terminal.

- Produce one complete `.html` file.
- Include `<!doctype html>`, `<title>`, and viewport meta.
- Prefer inline CSS and small inline vanilla JavaScript.
- Avoid external scripts/styles unless explicitly useful.
- Use semantic structure: `header`, `main`, `section`, `article`, `aside`, `nav`, `table`, `pre`, `code`.
- Use CSS custom properties for palette, type, spacing, and panel rules.
- Keep layouts dense, readable, and product-specific.
- Use SVG for diagrams when visual structure matters.
- Interactive artifacts must include a copy/export path or be suitable for prtl feedback.
- Avoid markdown pasted into an HTML wrapper, generic heroes, nested card piles, and decorative blobs.
