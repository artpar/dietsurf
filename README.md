# DietSurf

DietSurf is a minimal Chrome side-panel browser agent. It gives the agent and the
user one shared shell, one editable virtual filesystem, and small editable agent
loops instead of a separate workflow UI.

The extension seeds its editable project files into IndexedDB, then runs
`/main/src/agent.js` and `/staging/src/agent.js` through the DietSurf kernel.
After first load, the virtual files inside the extension are the live source of
truth; the packaged files are reset material and defaults.

## What It Does

- Opens as a Chrome side panel with Main and Staging terminal panes stacked
  vertically.
- Runs direct shell commands such as `ls`, `cat`, `grep`, `node`, `sed`, and
  heredoc writes.
- Treats non-shell input as a goal and routes it through that pane's explicit
  agent path: `/main/src/agent.js` or `/staging/src/agent.js`.
- Lets the agent inspect and edit the same virtual project files the user sees.
- Seeds literal `/main/**` and `/staging/**` project copies. These are normal
  visible filesystem paths, not aliases.
- Builds a loadable unpacked extension under `build/unpacked`.

## Quick Start

Install dependencies:

```sh
npm install
```

Build the unpacked extension:

```sh
npm run build
```

Load this directory in Chrome:

```text
build/unpacked
```

For extension-mode LLM calls, set the API key inside the virtual
`/main/etc/llm.json` and `/staging/etc/llm.json` files from the side-panel
shell. For local Node mode, `.env` can provide `LILAC_API_KEY`.

## Useful Commands

```sh
npm test
npm run build
npm run build:plugin
npm run dev:extension
npm run e2e:real-user
```

`npm run build` writes generated extension files into `build/unpacked`. The
older root-level `dist/` output is intentionally not used.

## Project Shape

```text
manifest.json             Chrome extension manifest
worker.js                 service-worker bootloader and virtual filesystem
sidepanel.js              side-panel bootloader
src/agent.js              editable default agent and UI source seeded into both panes
src/kernel/*              shell, runtime, JS-like module execution, VFS helpers
etc/profile               runtime instructions exposed to the agent
scripts/build-unpacked.mjs builds the loadable unpacked extension
```

## Notes

The browser shell is not a host shell. Commands such as `npm`, `npx`, and
`esbuild` are development commands that run outside DietSurf, not inside the
extension's virtual shell.
