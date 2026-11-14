# Free PDF Editor

A fully free, browser-based PDF editor — a self-contained clone of an "Edit PDF Online"
landing page + editor workflow. **Everything is free: no sign-up, no subscription, no
watermark, no file limits, no server.** All processing happens client-side in the browser.

## Features

- **Edit existing text** — Find & Replace rewrites the words already in your PDF,
  matched to their original position.
- **Add text** — click anywhere to place text with font, size, and color controls.
- **Annotations** — freehand drawing, highlighter, rectangles, ellipses, lines,
  arrows, and sticky notes.
- **Images** — insert PNG/JPG images and move them around.
- **Signatures** — type, draw, or upload a signature and drop it onto any page.
- **Page management** — reorder, rotate, duplicate, delete, and add pages.
- **Download** — export a flattened PDF with all edits baked in.

## Tech

- [PDF.js](https://mozilla.github.io/pdf.js/) (vendored in `lib/pdfjs/`) — page rendering & text extraction
- [pdf-lib](https://pdf-lib.js.org/) (vendored in `lib/pdf-lib/`) — page operations & flattening on export
- Plain HTML/CSS/JS — no build step, no framework

## Run

Serve the repository root with any static file server, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/` for the landing page, drop in a PDF, and start editing.

## How "fully free" works

There is no backend and no accounts — the editor runs entirely in your browser and files
never leave your device. There are no tiers or credits, so every feature is unlocked
from the first click.
