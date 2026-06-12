# Prism

One prompt refracted into three answers, side by side. A single web page fans your prompt out to
**Claude**, **Gemini**, and **ChatGPT** by shelling out to each vendor's official CLI,
so it runs on your existing **subscriptions** instead of per-token API billing.

![Prism, one prompt answered by Claude, Gemini, and ChatGPT side by side](docs/screenshot.png)

```
Browser (3 panes + 1 prompt)
   |  POST /ask  -> streamed NDJSON back
Node/Express
   |- spawn  claude -p ... --output-format stream-json   -> pane 1 (live tokens)
   |- spawn  gemini --skip-trust -p ...                  -> pane 2
   |- spawn  codex exec --json ...                       -> pane 3
```

## Features

**Asking**
- One prompt fans out to all three models; answers stream side by side.
- `@Claude` / `@Gemini` / `@Codex` (or `@ChatGPT`) targets only those models; no
  mention uses your default models (Settings).
- Drag & drop (or paperclip) attaches text, code, images, and PDFs.
- Every model sees the full conversation history, including turns answered by
  other models, so follow-ups work across panes.
- Markdown and LaTeX (MathJax) rendering; Enter sends, Shift+Enter newlines.

**Comparing the models**
- **Compare answers**: a semantic synthesis of the turn: consensus, differences
  (who says what), and unique points.
- **Criticize**: every model critiques the other models' answers; or click the
  `!` icon on one box to have the others critique just that answer.
- Syntheses and critiques are saved with the chat.

**Per-response tools** (box header)
- Expand a box to full width, copy the answer as markdown, delete an answer
  (also removed from future context).
- **Humanize**: rewrite an answer to remove the AI tone (Korean text); a
  Settings toggle applies it to every response automatically.

**Chats**
- Auto-saved history in the sidebar: rename (double-click), delete, deep-link
  via `?conv=<id>`.
- **Temporary chat** mode: nothing is saved.
- Per-turn and per-response deletion edits what context later turns see.

**Settings & Skills**
- Default models, base model per service (`opus`/`sonnet`/`haiku` or custom),
  font family/size.
- Enable/disable each CLI's skills (Claude, Gemini, Codex) from the Skills
  panel.
- Update banner when the GitHub repo is ahead of your running version; the
  server auto-restarts when a CLI binary updates.

## Prerequisites

The three CLIs must be installed and **logged in** (each uses its own subscription auth):

| Pane    | CLI        | Install                              | Log in            |
|---------|------------|--------------------------------------|-------------------|
| Claude  | `claude`   | Claude Code                          | already signed in |
| Gemini  | `gemini`   | `npm i -g @google/gemini-cli`        | `gemini` (OAuth)  |
| ChatGPT | `codex`    | `brew install codex` / npm           | `codex login`     |

Check: `claude --version`, `gemini --version`, `codex --version` should all print.

## Run

```bash
npm install
node server.js        # http://localhost:3000
```

Type a prompt, press **Enter** (Shift+Enter for a newline). Each box streams its model's
answer. Past chats are saved automatically and listed in the left sidebar.

## Run at startup (macOS)

A launchd LaunchAgent starts the server at login and restarts it if it crashes, so
`http://localhost:3000` is always available. The agent sets `PATH`/`HOME` explicitly
because launchd's default environment is too minimal to find the three CLIs.

```bash
# install / reload
launchctl load -w ~/Library/LaunchAgents/com.dongwookim.aggregationai.plist
# status (pid, last exit code)
launchctl list | grep aggregationai
# stop + remove from startup
launchctl unload -w ~/Library/LaunchAgents/com.dongwookim.aggregationai.plist
# logs
tail -f server.log server.err.log
```

After editing `server.js`, restart it with:
`launchctl kickstart -k gui/$(id -u)/com.dongwookim.aggregationai`

## How it works

- `server.js` spawns the three CLIs in parallel, each with its working directory set to
  a throwaway scratch dir (`$TMPDIR/aggai-scratch`) so the agentic CLIs never touch real
  projects. Each model's `parse()` pulls plain text out of one stdout line:
  - **Claude**: `stream-json` deltas (`stream_event -> content_block_delta -> text_delta`)
  - **Codex**: `--json` events (`item.completed` where `item.type === "agent_message"`)
  - **Gemini**: plain stdout, forwarded as-is
- The browser streams the response as newline-delimited JSON and appends each chunk to
  its pane.

## Notes

- These are coding **agents**, not chat endpoints. For a plain question they just answer,
  but they can use tools. Codex runs `--sandbox read-only`; Claude/Gemini run in the
  scratch dir.
- To add or reorder models, edit the `MODELS` map in `server.js`. The UI builds its panes
  from `/models`.
