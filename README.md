# md-editor

**English** | [한국어](#한국어)

A fast, local-first **Markdown editor** for the desktop, built with
[Tauri 2](https://tauri.app/), [SvelteKit](https://kit.svelte.dev/), and
[CodeMirror 6](https://codemirror.net/). It edits files directly on disk, opens
multiple documents in tabs, restores your session on the next launch, and
ships as a small native Windows installer.

**Made for Markdown beginners.** You don't need to memorize Markdown syntax —
format headings, tables, bold/italic, lists, links, and code blocks from the
right-click menu or with familiar shortcuts (<kbd>Ctrl</kbd>+<kbd>B</kbd>,
<kbd>Ctrl</kbd>+<kbd>I</kbd>, …), and switch to a clean rendered preview with
<kbd>Ctrl</kbd>+<kbd>E</kbd> to see how it looks.

> Status: early (0.1.x). Windows is the primary target; the codebase is
> cross-platform but only Windows installers are produced today.

## Features

- **Live-preview editing** — headings, emphasis, lists, and code render inline
  while you keep the raw Markdown editable.
- **Real tables** — Markdown pipe tables are rendered as actual tables. Type a
  header row and press <kbd>Enter</kbd> to auto-complete the alignment row;
  typing <kbd>|</kbd> adds a column to every row at once. Right-click a cell to
  insert/delete rows and columns, or copy the table as **TSV (Excel)** / HTML.
- **Viewer mode** (<kbd>Ctrl</kbd>+<kbd>E</kbd>) — a rendered, read-only view
  with syntax-highlighted code blocks and clickable bare URLs. External images
  are blocked by default and can be enabled from the View menu.
- **Tabs & session restore** — open many files at once; unsaved buffers are
  restored automatically when you reopen the app.
- **Drag-and-drop & file association** — drop `.md` files onto the window, or
  set md-editor as the default app so double-clicking a `.md` opens it (each
  file in its own tab; a single running instance is reused).
- **Light / Dark / Follow-System themes** — switch from the View menu; the
  choice is remembered.
- **Code-fence highlighting** — JavaScript, TypeScript, Python, SQL, JSON,
  HTML, CSS, Rust, YAML, Markdown, and more.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> / <kbd>O</kbd> / <kbd>S</kbd> | New / Open / Save |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Save As |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> / <kbd>W</kbd> | New tab / Close tab |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd>, <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Switch tabs |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>`</kbd> | Bold / Italic / Inline code |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | Toggle Edit / Viewer |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd> | Zoom in / out / reset |
| <kbd>Enter</kbd> (in a table cell) | In-cell line break (`<br>`) |
| <kbd>Enter</kbd> (end of a table row) | Add a new row |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (in a table) | Exit the table onto a new line |

Right-click inside the editor for headings, table operations, lists,
blockquotes, links, code blocks, and more.

## Install (Windows)

Grab an installer from the [Releases](https://github.com/pal815/md-editor/releases)
page:

- **`md-editor_x.y.z_x64-setup.exe`** (NSIS) — recommended; per-user install,
  no admin prompt.
- **`md-editor_x.y.z_x64_en-US.msi`** (MSI) — for group-policy / MDM deployment.

**File association (opt-in).** The installer does **not** touch your file
associations. To register md-editor as a Markdown handler, use the in-app menu
**File → Set as .md Handler…** — this adds a per-user entry (under
`HKCU`, no admin rights) for `.md`, `.markdown`, `.mdown`, and `.mkd`, so
md-editor shows up in the *Open with* list. **File → Remove .md Handler**
reverts it.

To make it the **default** app after registering: right-click any `.md` file →
*Open with* → *Choose another app* → **md-editor** → check *Always*. (Windows
requires this one-time user confirmation — apps cannot silently seize the
default handler on modern Windows.)

## Build from source

**Prerequisites**

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Tauri prerequisites for your OS — see the
  [Tauri guide](https://tauri.app/start/prerequisites/). On Windows this means
  the **WebView2 runtime** and the **MSVC** build tools.

**Develop**

```bash
pnpm install
pnpm tauri dev
```

**Produce installers**

```bash
pnpm tauri build
```

Artifacts are written to `src-tauri/target/release/` (portable `.exe`) and
`src-tauri/target/release/bundle/` (MSI + NSIS).

**Type-check**

```bash
pnpm run check          # Svelte / TypeScript
cargo check             # run inside src-tauri/
```

## Security notes

md-editor is local-first and makes no network requests of its own.

- The Rust backend only reads/writes files the user explicitly picked (via the
  native dialog, drag-and-drop, file association, or restored session). A
  server-side **approve-list** prevents a compromised renderer from reading
  arbitrary paths; UNC/network paths, NTFS alternate data streams, and system
  directories are rejected, and file operations are capped at 64 MB.
- A strict Content-Security-Policy is applied (`default-src 'self'`,
  `object-src 'none'`, no inline scripts).
- Viewer-mode HTML is sanitized with [DOMPurify](https://github.com/cure53/DOMPurify);
  external images are off by default.

## Tech stack

Tauri 2 · SvelteKit (adapter-static) · Svelte 5 (runes) · TypeScript ·
CodeMirror 6 · @lezer/markdown · pulldown-cmark · highlight.js · DOMPurify

## Acknowledgements

This project was developed with the assistance of
[Claude Code](https://claude.com/claude-code) (Anthropic) and
[Codex](https://openai.com/codex) (OpenAI), used for implementation, code
review, and cross-verification throughout development.

## License

[MIT](LICENSE) © 2026 pal815

This project bundles third-party open-source components (all permissively
licensed). Their notices are collected in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

---

# 한국어

[English](#md-editor) | **한국어**

Tauri 2, SvelteKit, CodeMirror 6로 만든 **로컬 우선(local-first) 데스크톱
마크다운 에디터**입니다. 파일을 디스크에서 직접 편집하고, 여러 문서를 탭으로
열며, 다음 실행 시 세션을 복원하고, 가벼운 Windows 네이티브 설치 파일로
배포됩니다.

**마크다운 입문자를 위해 만들었습니다.** 마크다운 문법을 외울 필요가 없습니다 —
제목, 표, 굵게/기울임, 목록, 링크, 코드 블록을 우클릭 메뉴나 익숙한 단축키
(<kbd>Ctrl</kbd>+<kbd>B</kbd>, <kbd>Ctrl</kbd>+<kbd>I</kbd> 등)로 적용하고,
<kbd>Ctrl</kbd>+<kbd>E</kbd>로 깔끔하게 렌더링된 미리보기를 보며 결과를 확인할
수 있습니다.

> 상태: 초기 버전(0.1.x). 주 대상은 Windows이며, 코드베이스는 크로스플랫폼이지만
> 현재는 Windows 설치 파일만 빌드합니다.

## 주요 기능

- **라이브 프리뷰 편집** — 제목·강조·목록·코드가 인라인으로 렌더링되면서도
  원본 마크다운은 그대로 편집할 수 있습니다.
- **실제 표 렌더링** — 마크다운 파이프 표를 진짜 표 모양으로 보여줍니다. 헤더
  행을 입력하고 <kbd>Enter</kbd>를 누르면 정렬 행이 자동 완성되고, <kbd>|</kbd>를
  입력하면 모든 행에 동시에 열이 추가됩니다. 셀을 우클릭해 행/열을 추가·삭제하거나
  표를 **TSV(엑셀)** / HTML 로 복사할 수 있습니다.
- **뷰어 모드** (<kbd>Ctrl</kbd>+<kbd>E</kbd>) — 코드 블록 구문 강조와 클릭
  가능한 평문 URL이 적용된 읽기 전용 렌더링 화면입니다. 외부 이미지는 기본
  차단이며 View 메뉴에서 허용할 수 있습니다.
- **탭 & 세션 복원** — 여러 파일을 동시에 열 수 있고, 저장하지 않은 내용도 앱을
  다시 열면 자동으로 복원됩니다.
- **드래그 앤 드롭 & 파일 연결** — `.md` 파일을 창에 끌어다 놓거나, md-editor를
  기본 앱으로 지정해 `.md` 더블클릭으로 열 수 있습니다(각 파일이 별도 탭으로
  열리고, 실행 중인 인스턴스를 재사용합니다).
- **라이트 / 다크 / 시스템 따름 테마** — View 메뉴에서 전환하며, 선택은
  기억됩니다.
- **코드 펜스 구문 강조** — JavaScript, TypeScript, Python, SQL, JSON, HTML,
  CSS, Rust, YAML, Markdown 등.

## 단축키

| 단축키 | 동작 |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> / <kbd>O</kbd> / <kbd>S</kbd> | 새 문서 / 열기 / 저장 |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | 다른 이름으로 저장 |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> / <kbd>W</kbd> | 새 탭 / 탭 닫기 |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd>, <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | 탭 전환 |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>`</kbd> | 굵게 / 기울임 / 인라인 코드 |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | 편집 / 뷰어 전환 |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd> | 확대 / 축소 / 원래대로 |
| <kbd>Enter</kbd> (표 셀 안) | 셀 내 줄바꿈 (`<br>`) |
| <kbd>Enter</kbd> (표 행 끝) | 새 행 추가 |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (표 안) | 표를 끝내고 다음 줄로 |

편집 영역을 우클릭하면 제목, 표 조작, 목록, 인용, 링크, 코드 블록 등의 메뉴가
나옵니다.

## 설치 (Windows)

[Releases](https://github.com/pal815/md-editor/releases) 페이지에서 설치
파일을 받으세요:

- **`md-editor_x.y.z_x64-setup.exe`** (NSIS) — 권장. 사용자 단위 설치이며 관리자
  권한 프롬프트가 없습니다.
- **`md-editor_x.y.z_x64_en-US.msi`** (MSI) — 그룹 정책 / MDM 배포용.

**파일 연결 (선택).** 설치 프로그램은 파일 연결을 **건드리지 않습니다.**
md-editor를 마크다운 처리기로 등록하려면 앱 메뉴 **File → Set as .md Handler…**
를 사용하세요 — 관리자 권한 없이 사용자 레지스트리(`HKCU`)에 `.md`, `.markdown`,
`.mdown`, `.mkd` 항목을 추가하여 *연결 프로그램* 목록에 md-editor가 나타나게
합니다. **File → Remove .md Handler** 로 해제합니다.

등록 후 **기본 앱**으로 지정하려면: `.md` 파일 우클릭 → *연결 프로그램* →
*다른 앱 선택* → **md-editor** → *항상* 체크. (최신 Windows는 앱이 기본 앱을
임의로 가로채는 것을 막으므로, 이 한 번의 사용자 확인이 필요합니다.)

## 소스에서 빌드

**사전 요구사항**

- [Node.js](https://nodejs.org/) 18+ 와 [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- OS별 Tauri 사전 요구사항 — [Tauri 가이드](https://tauri.app/start/prerequisites/)
  참고. Windows에서는 **WebView2 런타임**과 **MSVC** 빌드 도구가 필요합니다.

**개발 실행**

```bash
pnpm install
pnpm tauri dev
```

**설치 파일 생성**

```bash
pnpm tauri build
```

산출물은 `src-tauri/target/release/`(포터블 `.exe`)와
`src-tauri/target/release/bundle/`(MSI + NSIS)에 생성됩니다.

**타입 검사**

```bash
pnpm run check          # Svelte / TypeScript
cargo check             # src-tauri/ 안에서 실행
```

## 보안 참고

md-editor는 로컬 우선이며 자체적으로 네트워크 요청을 하지 않습니다.

- Rust 백엔드는 사용자가 명시적으로 고른 파일만 읽고 씁니다(네이티브 대화상자,
  드래그 앤 드롭, 파일 연결, 복원된 세션 경유). 서버 측 **승인 목록(approve-list)**
  으로 손상된 렌더러가 임의 경로를 읽지 못하게 막고, UNC/네트워크 경로·NTFS 대체
  데이터 스트림·시스템 디렉터리는 거부하며, 파일 작업은 64 MB로 제한됩니다.
- 엄격한 콘텐츠 보안 정책(CSP)을 적용합니다(`default-src 'self'`,
  `object-src 'none'`, 인라인 스크립트 금지).
- 뷰어 모드의 HTML은 [DOMPurify](https://github.com/cure53/DOMPurify)로
  정화하며, 외부 이미지는 기본적으로 꺼져 있습니다.

## 기술 스택

Tauri 2 · SvelteKit (adapter-static) · Svelte 5 (runes) · TypeScript ·
CodeMirror 6 · @lezer/markdown · pulldown-cmark · highlight.js · DOMPurify

## 개발 도구 / 감사의 글

이 프로젝트는 [Claude Code](https://claude.com/claude-code)(Anthropic)와
[Codex](https://openai.com/codex)(OpenAI)의 도움을 받아 개발되었습니다. 구현,
코드 리뷰, 교차 검증 전반에 두 도구를 활용했습니다.

## 라이선스

[MIT](LICENSE) © 2026 pal815

이 프로젝트는 제3자 오픈소스 구성요소(모두 허용형 라이선스)를 포함합니다. 관련
고지는 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)에 모았습니다.
