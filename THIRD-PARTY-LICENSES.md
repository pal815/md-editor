# Third-Party Licenses

md-editor bundles the following open-source components. Each is distributed
under its own license; the copyright and permission notices below are
preserved as required. All listed licenses are permissive and compatible with
this project's MIT license.

To regenerate a complete, machine-verified manifest:

- **JavaScript deps:** `npx license-checker --production --summary`
- **Rust crates:** `cargo install cargo-about && cargo about generate about.hbs`
  (run inside `src-tauri/`)

---

## Frontend (npm)

| Package | License |
| --- | --- |
| `@codemirror/*` (state, view, commands, language, search, lang-markdown, lang-javascript, lang-python, lang-sql, lang-json, lang-html, lang-css, lang-rust, lang-yaml) | MIT |
| `@codemirror/theme-one-dark` | MIT |
| `@lezer/markdown` | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog`, `plugin-fs`, `plugin-opener` | MIT OR Apache-2.0 |
| `dompurify` | (MPL-2.0 OR Apache-2.0) — used under Apache-2.0 |
| `highlight.js` | BSD-3-Clause |
| `svelte`, `@sveltejs/kit`, `vite` (build-time only) | MIT |

### highlight.js — BSD-3-Clause

```
Copyright (c) 2006, Ivan Sagalaev. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

  * Redistributions of source code must retain the above copyright notice,
    this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.
  * Neither the name of the copyright holder nor the names of its contributors
    may be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES ... ARE DISCLAIMED. (full text in the
highlight.js distribution)
```

> The syntax-highlight token colours used in Viewer mode are re-implementations
> of the well-known **Atom One Dark / Atom One Light** palettes (colour values
> only — no source code was copied). Colour values are not copyrightable.

---

## Backend (Rust crates)

| Crate | License |
| --- | --- |
| `tauri`, `tauri-build`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-single-instance` | MIT OR Apache-2.0 |
| `serde`, `serde_json` | MIT OR Apache-2.0 |
| `tokio` | MIT |
| `pulldown-cmark` | MIT |
| `thiserror` | MIT OR Apache-2.0 |
| Transitive (`wry`, `webview2-com`, `ring`, etc.) | MIT / Apache-2.0 / BSD / ISC |

For Rust crates dual-licensed as "MIT OR Apache-2.0", this project elects the
MIT terms. Full per-crate texts are reproducible via `cargo about`.

---

_If you redistribute md-editor in binary form, include this file (or an
equivalent attribution manifest) alongside the binary._
