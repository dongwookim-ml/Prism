# AggregationAI

One prompt, three answers side by side. A single web page fans your prompt out to
**Claude**, **Gemini**, and **ChatGPT** by shelling out to each vendor's official CLI,
so it runs on your existing **subscriptions** instead of per-token API billing.

```
Browser (3 panes + 1 prompt)
   |  POST /ask  -> streamed NDJSON back
Node/Express
   |- spawn  claude -p ... --output-format stream-json   -> pane 1 (live tokens)
   |- spawn  gemini --skip-trust -p ...                  -> pane 2
   |- spawn  codex exec --json ...                       -> pane 3
```

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
