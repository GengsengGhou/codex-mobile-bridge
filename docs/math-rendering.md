# Formula rendering

The bridge renders inline `$...$` and `\(...\)` expressions and display `$$...$$` and `\[...\]` expressions with bundled KaTeX 0.18.9. Multiline display blocks, aligned equations, matrices and formulas in Markdown table cells are supported. MathML accompanies the visual output for accessibility. Formula sizes follow the existing 10-48 px font control; wide expressions scroll within their own region without widening the page.

Code spans and fenced code remain literal. Escaped delimiters and ordinary numeric prices are preserved; a single-dollar expression cannot close on part of a double-dollar delimiter. Invalid, unsupported, incomplete or over-budget expressions remain readable as source. This is a Markdown subset, not a full TeX document processor.

Rendering permits no trusted HTML or URL commands (`trust: false`). Limits are 128 rendered formulas per message, 4096 source characters per expression, 256 lines per display block, 1000 macro expansions and a maximum KaTeX size of 20. A missing renderer also falls back to source, preserving the rest of the application.

## Local assets and deployment

`npm run vendor:math` regenerates the committed ESM renderer, CSS, MIT license, manifest and 20 WOFF2 fonts from the pinned development dependency. Production does not install or contact a math CDN. CSS references only bundled WOFF2 files. The local bridge, temporary authenticated gateway and device hub share an exact asset whitelist, JavaScript/font MIME types and CSP. The CSP retains self-only scripts and fonts; KaTeX's generated style attributes require `style-src-attr 'unsafe-inline'`.

The release packager includes these assets and `src/static-assets.mjs`. Deploy the manifest, assets and shared module before loading a server that imports the module. Restart only the bridge child under its existing supervisor and the dedicated hub service after checking no requests or journal writes are in flight. Pairing, sessions, stored receipts, database and environment files are retained. The inactive temporary gateway uses the updated source on its next ordinary start.

## Verification (2026-09-27)

The complete automated suite passed 340 tests. Added cases cover delimiters, multiline and table parsing, code/currency safety, malformed and hostile inputs, rendering budgets and vendor completeness. HTTP tests cover local and authenticated temporary serving, plus hub owner/device isolation, MIME types and CSP.

`work/codex-probe/accept-math-ui.mjs` uses the actual application and assets with a GET-only scientific fixture overlaid on the authorized acceptance conversation. It sends no messages. Five viewports cover 320/390 px phones at 20/48 px and a 1440 px desktop. Nine accessible expressions render with one intentional malformed fallback; matrix, aligned, integral, fraction and norm expressions, code literals and prices are checked. Wide formulas scroll horizontally; page width matches each viewport. There are no page, console or CSP errors, and renderer/CSS/font requests succeed.

Evidence is recorded in `work/codex-probe/math-ui-evidence.json`, `math-full-test.log`, screenshots prefixed `math-`, and `math-deployment-evidence.json`. The post-reload browser run uses production port 4317. Remote deployment is verified by exact file hashes, service health and connector reconnection. An authenticated remote browser session and physical phone touch/visual behavior have not been verified.
