const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Agentic CLIs run with this as their working root so they never touch real projects.
const SCRATCH = path.join(os.tmpdir(), 'aggai-scratch');
fs.mkdirSync(SCRATCH, { recursive: true });

// Conversations are persisted as one JSON file per chat under data/.
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const safeId = (id) => String(id).replace(/[^\w-]/g, ''); // no path traversal
const convPath = (id) => path.join(DATA_DIR, `${safeId(id)}.json`);
const loadConv = (id) => { try { return JSON.parse(fs.readFileSync(convPath(id), 'utf8')); } catch { return null; } };
const saveConv = (c) => fs.writeFileSync(convPath(c.id), JSON.stringify(c, null, 2));

function listConvs() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadConv(path.basename(f, '.json')))
    .filter(Boolean)
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Append one completed turn (prompt + each model's full response), creating the
// conversation if it doesn't exist yet. Returns the conversation.
function saveTurn(id, prompt, responses, attachments) {
  const now = new Date().toISOString();
  let conv = id ? loadConv(id) : null;
  if (!conv) {
    const title = prompt.split('\n')[0].slice(0, 60) || (attachments?.length ? attachments.join(', ').slice(0, 60) : 'Untitled');
    conv = { id: crypto.randomUUID(), title, createdAt: now, turns: [] };
  }
  conv.turns.push({ prompt, attachments, responses, ts: now });
  conv.updatedAt = now;
  saveConv(conv);
  return conv;
}

// Each model: how to invoke its CLI non-interactively, and how to pull plain
// text out of a single stdout line. parse() returns the text to append, or null
// to ignore the line (metadata, events, non-JSON noise).
const MODELS = {
  claude: {
    label: 'Claude (Claude Code)',
    cmd: 'claude',
    // Reads attached files (incl. images, PDFs) from its working dir via the Read tool.
    // --allowedTools must come LAST: it's variadic and would otherwise eat the prompt.
    // Pre-approving WebSearch/WebFetch lets Claude search the web in headless mode.
    args: (p, ctx) => ['-p', filePreamble(ctx.attachments) + p, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--allowedTools', 'WebSearch', 'WebFetch'],
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
    // --skip-trust: scratch dir isn't a "trusted" workspace. @name pulls each
    // attached file in as real (multimodal) input, which it needs to view images.
    args: (p, ctx) => {
      const refs = (ctx.attachments || []).map((n) => '@' + n).join(' ');
      return ['--skip-trust', '-p', refs ? `${p}\n\n${refs}` : p];
    },
    parse: null, // plain text on stdout: forward as-is
  },
  codex: {
    label: 'ChatGPT (Codex CLI)',
    cmd: 'codex',
    // Prompt must come BEFORE -i: --image is variadic and would otherwise eat the prompt.
    args: (p, ctx) => [
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', filePreamble(ctx.attachments) + p,
      ...(ctx.images || []).flatMap((img) => ['-i', img]),
    ],
    parse: (o) => {
      if (o.type === 'item.completed' && o.item?.type === 'agent_message') return o.item.text;
      return null;
    },
  },
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Preamble (Claude/Codex) telling the agent the attached files are in its cwd.
const filePreamble = (names) => names && names.length
  ? `The user attached these files in your current working directory: ${names.join(', ')}. Read or view them as needed to answer.\n\n`
  : '';

const app = express();
app.use(express.json({ limit: '30mb' })); // room for base64-encoded file uploads
app.use(express.static(path.join(__dirname, 'public')));

app.get('/models', (_req, res) => {
  res.json(Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })));
});

app.get('/conversations', (_req, res) => res.json(listConvs()));

app.get('/conversations/:id', (req, res) => {
  const c = loadConv(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

app.delete('/conversations/:id', (req, res) => {
  try { fs.unlinkSync(convPath(req.params.id)); } catch {}
  res.json({ ok: true });
});

app.post('/ask', (req, res) => {
  const prompt = (req.body?.prompt || '').toString().trim();
  const conversationId = req.body?.conversationId || null;
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!prompt && !files.length) return res.status(400).json({ error: 'empty prompt' });

  // Uploaded files are written into a per-request dir that becomes each CLI's
  // working directory, so the agents can read/view them. They're named in the
  // prompt; images are also handed to Codex via -i.
  let cwd = SCRATCH;
  const images = [];
  const attachments = [];
  if (files.length) {
    cwd = path.join(SCRATCH, 'uploads', crypto.randomUUID());
    fs.mkdirSync(cwd, { recursive: true });
    for (const f of files) {
      const name = path.basename(String(f.name || 'file')); // strip any path components
      fs.writeFileSync(path.join(cwd, name), Buffer.from(String(f.dataBase64 || ''), 'base64'));
      attachments.push(name);
      if (IMAGE_RE.test(name)) images.push(path.join(cwd, name));
    }
  }
  // Each model builds its own file-aware prompt from `attachments` (see MODELS).
  const basePrompt = prompt || (files.length ? 'Please review the attached file(s).' : '');

  // Stream newline-delimited JSON events back to the browser as they happen.
  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  const ids = Object.keys(MODELS);
  const collected = Object.fromEntries(ids.map((id) => [id, ''])); // full text per model, for saving
  const emitChunk = (id, text) => { collected[id] += text; emit({ type: 'chunk', model: id, text }); };
  let remaining = ids.length;
  const children = [];

  for (const id of ids) {
    const cfg = MODELS[id];
    const child = spawn(cfg.cmd, cfg.args(basePrompt, { images, attachments }), {
      cwd,
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
          emitChunk(id, line + '\n');
          continue;
        }
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; } // skip non-JSON noise
        const text = cfg.parse(parsed);
        if (text) emitChunk(id, text);
      }
    });

    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => {
      emitChunk(id, `[cannot start "${cfg.cmd}": ${e.message}. Is it installed and logged in?]`);
    });

    child.on('close', (code) => {
      if (!cfg.parse && out.trim()) emitChunk(id, out); // flush tail
      if (code && code !== 0) {
        const detail = err.trim() ? `\n${err.trim()}` : '';
        emitChunk(id, `\n[${id} exited with code ${code}]${detail}`);
      }
      emit({ type: 'done', model: id });
      if (--remaining === 0) {
        const conv = saveTurn(conversationId, prompt, collected, attachments);
        emit({ type: 'saved', conversationId: conv.id, title: conv.title });
        res.end();
      }
    });
  }

  // Kill children only on a real client disconnect, not when the POST body
  // finishes (req 'close' fires immediately on body receipt in modern Node).
  res.on('close', () => {
    if (!res.writableEnded) children.forEach((c) => c.kill('SIGTERM'));
  });
});

app.listen(PORT, () => console.log(`AggregationAI on http://localhost:${PORT}`));
