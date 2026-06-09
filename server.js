const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Agentic CLIs run with this as their working root so they never touch real projects.
const SCRATCH = path.join(os.tmpdir(), 'aggai-scratch');
fs.mkdirSync(SCRATCH, { recursive: true });

// Each model: how to invoke its CLI non-interactively, and how to pull plain
// text out of a single stdout line. parse() returns the text to append, or null
// to ignore the line (metadata, events, non-JSON noise).
const MODELS = {
  claude: {
    label: 'Claude (Claude Code)',
    cmd: 'claude',
    args: (p) => ['-p', p, '--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
    parse: (o) => {
      if (o.type === 'stream_event' &&
          o.event?.type === 'content_block_delta' &&
          o.event.delta?.type === 'text_delta') {
        return o.event.delta.text;
      }
      return null;
    },
  },
  gemini: {
    label: 'Gemini (Gemini CLI)',
    cmd: 'gemini',
    args: (p) => ['--skip-trust', '-p', p], // --skip-trust: scratch dir isn't a "trusted" workspace
    parse: null, // plain text on stdout: forward as-is
  },
  codex: {
    label: 'ChatGPT (Codex CLI)',
    cmd: 'codex',
    args: (p) => ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', p],
    parse: (o) => {
      if (o.type === 'item.completed' && o.item?.type === 'agent_message') return o.item.text;
      return null;
    },
  },
};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/models', (_req, res) => {
  res.json(Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })));
});

app.post('/ask', (req, res) => {
  const prompt = (req.body?.prompt || '').toString().trim();
  if (!prompt) return res.status(400).json({ error: 'empty prompt' });

  // Stream newline-delimited JSON events back to the browser as they happen.
  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  const ids = Object.keys(MODELS);
  let remaining = ids.length;
  const children = [];

  for (const id of ids) {
    const cfg = MODELS[id];
    const child = spawn(cfg.cmd, cfg.args(prompt), {
      cwd: SCRATCH,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    let out = '';
    let err = '';

    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!cfg.parse) {
          emit({ type: 'chunk', model: id, text: line + '\n' });
          continue;
        }
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; } // skip non-JSON noise
        const text = cfg.parse(parsed);
        if (text) emit({ type: 'chunk', model: id, text });
      }
    });

    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => {
      emit({ type: 'chunk', model: id, text: `[cannot start "${cfg.cmd}": ${e.message}. Is it installed and logged in?]` });
    });

    child.on('close', (code) => {
      if (!cfg.parse && out.trim()) emit({ type: 'chunk', model: id, text: out }); // flush tail
      if (code && code !== 0) {
        const detail = err.trim() ? `\n${err.trim()}` : '';
        emit({ type: 'chunk', model: id, text: `\n[${id} exited with code ${code}]${detail}` });
      }
      emit({ type: 'done', model: id });
      if (--remaining === 0) res.end();
    });
  }

  // Kill children only on a real client disconnect, not when the POST body
  // finishes (req 'close' fires immediately on body receipt in modern Node).
  res.on('close', () => {
    if (!res.writableEnded) children.forEach((c) => c.kill('SIGTERM'));
  });
});

app.listen(PORT, () => console.log(`AggregationAI on http://localhost:${PORT}`));
