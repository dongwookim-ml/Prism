# Repository Guidelines

## Project Structure & Module Organization

Prism is a small CommonJS Node/Express application.

- `server.js`: HTTP routes, conversation persistence, settings, CLI process spawning, and streamed response parsing.
- `public/index.html`: single-page UI, including HTML, CSS, and browser-side JavaScript.
- `public/vendor/`: checked-in browser dependencies used without a bundler.
- `data/`: runtime-generated conversations and settings. This directory is gitignored; do not commit user data.
- `docs/screenshot.png`: README screenshot and other documentation assets.

Keep server behavior in `server.js` and UI behavior in `public/index.html` unless a larger refactor is explicitly justified.

## Build, Test, and Development Commands

```bash
npm install          # Install Express and vendored-library source packages
node server.js       # Start Prism at http://localhost:3000
PORT=3001 node server.js
```

Before running, ensure `claude`, `gemini`, and `codex` are installed, authenticated, and available on `PATH`. There is no build step or working automated test command yet; `npm test` intentionally exits with an error.

For the documented macOS LaunchAgent setup, restart after server changes with:

```bash
launchctl kickstart -k gui/$(id -u)/com.dongwookim.aggregationai
```

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single-quoted JavaScript strings, and CommonJS `require()` imports. Follow existing concise naming: `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants such as `DATA_DIR`, and lowercase provider IDs (`claude`, `gemini`, `codex`). Prefer small helpers and early returns. Add comments only for non-obvious process, parsing, or security behavior.

No formatter or linter is configured. Match surrounding style and avoid unrelated formatting churn.

## Testing Guidelines

Manually verify affected flows in the browser: model streaming, conversation save/load/delete, settings persistence, file attachments, and temporary chats. For server changes, also confirm startup has no errors and inspect `server.log`/`server.err.log` when using launchd. Never use real project directories for agent CLI tests; preserve the scratch-directory isolation.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, often with a scope-like prefix, for example `Settings: per-service base model override`. Keep each commit focused and explain user-visible behavior.

Pull requests should include a concise description, manual verification steps, and screenshots for UI changes. Mention CLI compatibility or security implications when changing model commands, permissions, parsing, attachments, or persisted data.
