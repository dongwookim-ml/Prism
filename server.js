const express = require('express');
const { spawn, execFile } = require('child_process');
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
    .filter((c) => c && c.id && Array.isArray(c.turns)) // ignore non-conversation files (e.g. settings.json)
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

// ---- settings (skill selection) ----
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } };
const saveSettings = (s) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 25000 }, (err, stdout = '', stderr = '') => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
});

// Parse a SKILL.md frontmatter for name + description (handles folded scalars).
function readSkillMeta(dir) {
  let txt;
  try { txt = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return null; }
  const fm = txt.match(/^---\n([\s\S]*?)\n---/);
  const lines = (fm ? fm[1] : txt).split('\n');
  let name = '', description = '';
  for (let i = 0; i < lines.length; i++) {
    const n = lines[i].match(/^name:\s*(.*)$/);
    if (n) name = n[1].trim().replace(/^["']|["']$/g, '');
    const d = lines[i].match(/^description:\s*(.*)$/);
    if (d) {
      let v = d[1].trim();
      if (['>-', '>', '|', '|-', ''].includes(v)) {
        const buf = [];
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) buf.push(lines[j].trim());
        v = buf.join(' ');
      } else v = v.replace(/^["']|["']$/g, '');
      description = v;
    }
  }
  return name ? { name, description } : null;
}

// Claude's user-installed skills (deduped by name).
function claudeSkills() {
  const dir = path.join(os.homedir(), '.claude', 'skills');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; } // entries may be symlinks; readSkillMeta filters
  const byName = new Map();
  for (const n of names) {
    const meta = readSkillMeta(path.join(dir, n));
    if (meta && !byName.has(meta.name)) byName.set(meta.name, meta);
  }
  return [...byName.values()];
}

// Codex discovers user skills under ~/.agents/skills and system/plugin skills
// under ~/.codex/skills. Walk both trees because system skills are nested.
function codexSkills() {
  const byName = new Map();
  const visited = new Set();
  const visit = (dir) => {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const meta = readSkillMeta(dir);
    if (meta && !byName.has(meta.name)) byName.set(meta.name, meta);
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) visit(path.join(dir, entry.name));
    }
  };
  visit(path.join(os.homedir(), '.agents', 'skills'));
  visit(path.join(os.homedir(), '.codex', 'skills'));
  visit(path.join(os.homedir(), '.codex', 'plugins'));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Gemini's skills via its CLI (name + enabled state, which Gemini persists itself).
async function geminiSkills() {
  const { stdout } = await run('gemini', ['skills', 'list', '--all']);
  const skills = [];
  const re = /^([A-Za-z0-9._-]+)\s*\[(Enabled|Disabled)\]/gm;
  let m;
  while ((m = re.exec(stdout))) skills.push({ name: m[1], description: '', enabled: m[2] === 'Enabled' });
  return skills;
}

// Per-provider skills with their current enabled state for the settings UI.
async function listAllSkills() {
  const settings = loadSettings();
  const claudeEnabled = settings.skills?.claude; // undefined => all enabled
  const codexEnabled = settings.skills?.codex;
  const claude = claudeSkills().map((s) => ({ ...s, enabled: claudeEnabled ? claudeEnabled.includes(s.name) : true }));
  const codex = codexSkills().map((s) => ({ ...s, enabled: codexEnabled ? codexEnabled.includes(s.name) : true }));
  const gemini = await geminiSkills();
  return { claude, gemini, codex };
}

// Each model: how to invoke its CLI non-interactively, and how to pull plain
// text out of a single stdout line. parse() returns the text to append, or null
// to ignore the line (metadata, events, non-JSON noise).
const MODELS = {
  claude: {
    label: 'Claude (Claude Code)',
    cmd: 'claude',
    // Reads attached files (incl. images, PDFs) from its working dir via the Read tool.
    // --dangerously-skip-permissions bypasses all permission checks in headless mode,
    // which enables web search and every other tool without an interactive prompt.
    // Unselected skills are blocked via --disallowedTools Skill(name) (kept LAST: variadic).
    args: (p, ctx) => {
      const base = ['-p', filePreamble(ctx.attachments) + p, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--dangerously-skip-permissions'];
      if (ctx.model) base.push('--model', ctx.model);
      const disabled = ctx.disabledSkills || [];
      return disabled.length ? [...base, '--disallowedTools', ...disabled.map((n) => `Skill(${n})`)] : base;
    },
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
      const a = ['--skip-trust'];
      if (ctx.model) a.push('-m', ctx.model);
      a.push('-p', refs ? `${p}\n\n${refs}` : p);
      return a;
    },
    parse: null, // plain text on stdout: forward as-is
  },
  codex: {
    label: 'ChatGPT (Codex CLI)',
    cmd: 'codex',
    // Prompt must come BEFORE -i: --image is variadic and would otherwise eat the prompt.
    args: (p, ctx) => {
      const a = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (ctx.model) a.push('-m', ctx.model);
      a.push(filePreamble(ctx.attachments) + codexSkillPreamble(ctx.enabledSkills) + p, ...(ctx.images || []).flatMap((img) => ['-i', img]));
      return a;
    },
    parse: (o) => {
      // Codex emits each message as a separate agent_message item (e.g. a skill
      // preamble then the answer). Separate them with U+001E so the client can
      // style all but the last (preambles) as muted meta.
      if (o.type === 'item.completed' && o.item?.type === 'agent_message') return '' + o.item.text;
      return null;
    },
  },
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Preamble (Claude/Codex) telling the agent the attached files are in its cwd.
const filePreamble = (names) => names && names.length
  ? `The user attached these files in your current working directory: ${names.join(', ')}. Read or view them as needed to answer.\n\n`
  : '';

// Codex has no per-skill enable/disable CLI flag. Tell it which app-selected
// skills it may use; Codex's own skill instructions remain the source of truth.
const codexSkillPreamble = (skills) => {
  if (!skills) return '';
  if (!skills.length) return 'Do not use any Codex skills for this request.\n\n';
  const list = skills.map((s) => `- $${s.name}: ${s.description || 'Use when relevant.'}`).join('\n');
  return `Codex skills enabled in Prism for this request:\n${list}\nUse only these skills, and only when the task matches.\n\n`;
};

// Build a per-model prompt that prepends that model's own prior turns, so
// follow-ups carry context. Each pane is its own conversation thread.
function withHistory(priorTurns, id, current) {
  const clean = (s) => String(s || '').replace(//g, '\n').trim();
  const hist = priorTurns
    .filter((t) => t.responses && Object.values(t.responses).some((v) => clean(v)))
    .slice(-12) // bound prompt growth on long chats
    .map((t) => {
      // This model's own answer if it has one, else another model's (so it still
      // sees what was discussed when an earlier turn targeted a specific model).
      const ans = clean(t.responses[id]) || clean(Object.values(t.responses).find((v) => clean(v)));
      return `User: ${t.prompt || '[attached files]'}\nAssistant: ${ans}`;
    })
    .join('\n\n');
  if (!hist) return current;
  return `Earlier in this conversation:\n\n${hist}\n\nReply to the user's new message below, using that context.\n\nUser: ${current}`;
}

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

app.delete('/conversations/:id/turns/:turnIndex', (req, res) => {
  const c = loadConv(req.params.id);
  const ti = Number(req.params.turnIndex);
  if (!c || !Number.isInteger(ti) || !c.turns[ti]) return res.status(404).json({ error: 'not found' });
  c.turns.splice(ti, 1);
  c.updatedAt = new Date().toISOString();
  saveConv(c);
  res.json({ ok: true });
});

app.delete('/conversations/:id/turns/:turnIndex/responses/:model', (req, res) => {
  const c = loadConv(req.params.id);
  const ti = Number(req.params.turnIndex);
  if (!c || !c.turns[ti]) return res.status(404).json({ error: 'not found' });
  if (c.turns[ti].responses) delete c.turns[ti].responses[req.params.model];
  c.updatedAt = new Date().toISOString();
  saveConv(c);
  res.json({ ok: true });
});

app.post('/conversations/:id/rename', (req, res) => {
  const c = loadConv(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const title = (req.body?.title || '').toString().trim().slice(0, 100);
  if (title) { c.title = title; saveConv(c); }
  res.json({ ok: true, title: c.title });
});

// Is origin/main ahead of the running commit? Uses GitHub's compare API (public,
// https) so it works under launchd without ssh keys or a git fetch.
app.get('/version', async (_req, res) => {
  try {
    const { stdout } = await run('git', ['-C', __dirname, 'rev-parse', 'HEAD']);
    const local = stdout.trim();
    const r = await fetch(`https://api.github.com/repos/dongwookim-ml/Prism/compare/${local}...main`,
      { headers: { 'User-Agent': 'prism', 'Accept': 'application/vnd.github+json' } });
    if (!r.ok) return res.json({ behind: 0 });
    const j = await r.json();
    const latest = j.commits?.length ? j.commits[j.commits.length - 1].commit.message.split('\n')[0] : '';
    res.json({ behind: j.ahead_by || 0, latest });
  } catch { res.json({ behind: 0 }); }
});

app.get('/skills', async (_req, res) => {
  try { res.json(await listAllSkills()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/settings', (_req, res) => {
  const s = loadSettings();
  const dm = (s.defaultModels || []).filter((id) => MODELS[id]);
  res.json({ defaultModels: dm.length ? dm : Object.keys(MODELS), models: s.models || {} });
});

app.post('/settings', async (req, res) => {
  const claude = Array.isArray(req.body?.claude) ? req.body.claude.map(String) : null;
  const gemini = Array.isArray(req.body?.gemini) ? req.body.gemini.map(String) : null;
  const codex = Array.isArray(req.body?.codex) ? req.body.codex.map(String) : null;
  const defaultModels = Array.isArray(req.body?.defaultModels) ? req.body.defaultModels.filter((id) => MODELS[id]) : null;
  const serviceModels = (req.body?.models && typeof req.body.models === 'object') ? req.body.models : null;

  if (defaultModels) {
    const settings = loadSettings();
    settings.defaultModels = defaultModels;
    saveSettings(settings);
  }
  if (serviceModels) {
    const settings = loadSettings();
    settings.models = {};
    for (const id of Object.keys(MODELS)) {
      const v = String(serviceModels[id] || '').trim();
      if (v) settings.models[id] = v;
    }
    saveSettings(settings);
  }

  // Claude: app-scoped, stored and applied per request via --disallowedTools.
  if (claude) {
    const settings = loadSettings();
    settings.skills = { ...(settings.skills || {}), claude };
    saveSettings(settings);
  }
  // Codex: app-scoped, stored and included as per-request skill guidance.
  if (codex) {
    const settings = loadSettings();
    settings.skills = { ...(settings.skills || {}), codex };
    saveSettings(settings);
  }
  // Gemini: enable/disable is global state that Gemini persists itself.
  if (gemini) {
    const want = new Set(gemini);
    for (const s of await geminiSkills()) {
      const on = want.has(s.name);
      if (on !== s.enabled) await run('gemini', ['skills', on ? 'enable' : 'disable', s.name]);
    }
  }
  res.json({ ok: true });
});

// Rewrite a model's answer with the humanize-korean plugin (Claude runs the skill).
// stream-json (not default text) because launchd's non-TTY claude emits nothing
// in text mode. Body is wrapped in <<<R>>> tags so the skill's metrics get stripped.
app.post('/humanize', (req, res) => {
  const text = (req.body?.text || '').toString();
  if (!text.trim()) return res.status(400).json({ error: 'empty text' });
  // One-shot rewrite, NOT the humanize-korean skill (which spawns subagents and
  // is slow). sonnet + disallowed agentic tools force a single fast completion.
  const prompt = `다음 한글 텍스트를 사람이 쓴 것처럼 자연스럽게 윤문하세요. AI 티(번역투, 무생물 주어, 피동 남용, 과한 수식어, hedging, 기계적 병렬, 접속사 남발, 형식명사 남발)를 제거하되 의미, 사실, 숫자, 인용은 절대 바꾸지 마세요. 설명이나 메트릭 없이 윤문된 본문만 <<<R>>> 와 <<</R>>> 태그 사이에 출력하세요.\n\n${text}`;
  const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--disallowedTools', 'Skill', 'Task', 'Bash'],
    { cwd: SCRATCH, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { if (!res.writableEnded) res.status(500).json({ error: String(e) }); });
  child.on('close', (code) => {
    if (res.writableEnded) return;
    if (code && code !== 0) return res.status(500).json({ error: err.trim() || `exit ${code}` });
    let result = '';
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.type === 'result') result = o.result || ''; } catch {}
    }
    const tagged = result.match(/<<<R>>>([\s\S]*?)<<<\/R>>>/);
    res.json({ text: (tagged ? tagged[1] : result).trim() });
  });
  // Kill only on real client disconnect, not when the POST body finishes.
  res.on('close', () => { if (!res.writableEnded) child.kill('SIGTERM'); });
});

// Each model critiques the other models' answers (their answers as context).
app.post('/criticize', (req, res) => {
  const prompt = (req.body?.prompt || '').toString();
  const responses = (req.body?.responses && typeof req.body.responses === 'object') ? req.body.responses : {};
  const conversationId = req.body?.conversationId;
  const turnIndex = Number.isInteger(req.body?.turnIndex) ? req.body.turnIndex : null;
  const clean = (s) => String(s || '').replace(//g, '\n').trim();
  const ids = Object.keys(responses).filter((id) => MODELS[id] && clean(responses[id]));
  if (ids.length < 2) return res.status(400).json({ error: 'need at least two responses' });

  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  const critiques = {};
  let remaining = ids.length;
  const children = [];
  for (const id of ids) {
    const cfg = MODELS[id];
    const others = ids.filter((o) => o !== id)
      .map((o) => `### ${MODELS[o].label.split(' ')[0]}\n${clean(responses[o])}`).join('\n\n');
    const critPrompt = `Several AI assistants answered the same question.\n\nQuestion:\n${prompt || '(see answers)'}\n\nYour answer:\n${clean(responses[id])}\n\nThe other assistants answered:\n\n${others}\n\nCritique the other assistants' answers: factual errors, questionable claims, omissions, and where they are weaker or stronger than yours. Be specific and fair; concede good points. Concise markdown, same language as the answers. Do not restate your own answer.`;
    const child = spawn(cfg.cmd, cfg.args(critPrompt, {}), { cwd: SCRATCH, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '', err = '';
    critiques[id] = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!cfg.parse) { critiques[id] += line + '\n'; emit({ type: 'chunk', model: id, text: line + '\n' }); continue; }
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        const text = cfg.parse(parsed);
        if (text) { critiques[id] += text; emit({ type: 'chunk', model: id, text }); }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => emit({ type: 'chunk', model: id, text: `[cannot start "${cfg.cmd}": ${e.message}]` }));
    child.on('close', (code) => {
      if (!cfg.parse && out.trim()) { critiques[id] += out; emit({ type: 'chunk', model: id, text: out }); }
      if (code && code !== 0) emit({ type: 'chunk', model: id, text: `\n[${id} exited with code ${code}]${err.trim() ? '\n' + err.trim() : ''}` });
      emit({ type: 'done', model: id });
      if (--remaining === 0) {
        if (conversationId && turnIndex != null) {
          const c = loadConv(conversationId);
          if (c && c.turns[turnIndex]) { c.turns[turnIndex].critiques = critiques; saveConv(c); }
        }
        res.end();
      }
    });
  }
  res.on('close', () => { if (!res.writableEnded) children.forEach((c) => c.kill('SIGTERM')); });
});

// Semantic synthesis of the three answers (Consensus / Differences / Unique).
app.post('/compare', (req, res) => {
  const prompt = (req.body?.prompt || '').toString();
  const responses = (req.body?.responses && typeof req.body.responses === 'object') ? req.body.responses : {};
  const labels = { claude: 'Claude', gemini: 'Gemini', codex: 'ChatGPT' };
  const parts = Object.entries(responses)
    .filter(([, t]) => t && String(t).trim())
    .map(([id, t]) => `### ${labels[id] || id}\n${t}`).join('\n\n');
  if (!parts) return res.status(400).json({ error: 'no responses' });
  const conversationId = req.body?.conversationId;
  const turnIndex = Number.isInteger(req.body?.turnIndex) ? req.body.turnIndex : null;

  const cmpPrompt = `Three AI assistants answered the same question. Compare them at a semantic level, not word by word.\n\nQuestion:\n${prompt || '(inferred from the answers)'}\n\nAnswers:\n${parts}\n\nOutput ONLY this JSON between <<<R>>> and <<</R>>> tags, with string values in the same language as the answers:\n{"consensus":["point all or most agree on", ...],"differences":[{"topic":"short topic","positions":[{"model":"claude|gemini|codex","stance":"what this model says"}]}],"unique":[{"model":"claude|gemini|codex","point":"point only this model raised"}]}\nKeep each string short. Omit unique if none. Only include models that actually answered.`;
  const child = spawn('claude', ['-p', cmpPrompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--disallowedTools', 'Skill', 'Task', 'Bash'],
    { cwd: SCRATCH, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { if (!res.writableEnded) res.status(500).json({ error: String(e) }); });
  child.on('close', (code) => {
    if (res.writableEnded) return;
    if (code && code !== 0) return res.status(500).json({ error: err.trim() || `exit ${code}` });
    let result = '';
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.type === 'result') result = o.result || ''; } catch {}
    }
    const tagged = result.match(/<<<R>>>([\s\S]*?)<<<\/R>>>/);
    const synthesis = (tagged ? tagged[1] : result).trim();
    // Persist the synthesis on its turn so it survives reloads.
    if (conversationId && turnIndex != null) {
      const c = loadConv(conversationId);
      if (c && c.turns[turnIndex]) { c.turns[turnIndex].synthesis = synthesis; saveConv(c); }
    }
    res.json({ text: synthesis });
  });
  res.on('close', () => { if (!res.writableEnded) child.kill('SIGTERM'); });
});

app.post('/ask', (req, res) => {
  const prompt = (req.body?.prompt || '').toString().trim();
  const conversationId = req.body?.conversationId || null;
  const temporary = !!req.body?.temporary; // ephemeral chat: never saved to disk
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

  // Apply app-scoped Claude/Codex skill selections.
  const skillSettings = loadSettings().skills || {};
  const enabledClaude = skillSettings.claude; // undefined => all enabled
  const disabledSkills = enabledClaude ? claudeSkills().map((s) => s.name).filter((n) => !enabledClaude.includes(n)) : [];
  const allCodexSkills = codexSkills();
  const enabledCodex = skillSettings.codex
    ? allCodexSkills.filter((s) => skillSettings.codex.includes(s.name))
    : allCodexSkills;

  // Prior turns of this conversation become per-model context (none for new/temporary chats).
  const priorTurns = (!temporary && conversationId) ? (loadConv(conversationId)?.turns || []) : [];

  // Per-service base model override (empty => CLI default).
  const serviceModels = loadSettings().models || {};

  // Stream newline-delimited JSON events back to the browser as they happen.
  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  // Models for this turn: explicit (from @mentions) -> saved defaults -> all.
  const requested = Array.isArray(req.body?.models) ? req.body.models.filter((id) => MODELS[id]) : [];
  const defaultModels = (loadSettings().defaultModels || []).filter((id) => MODELS[id]);
  const ids = requested.length ? requested : (defaultModels.length ? defaultModels : Object.keys(MODELS));
  const collected = Object.fromEntries(ids.map((id) => [id, ''])); // full text per model, for saving
  const emitChunk = (id, text) => { collected[id] += text; emit({ type: 'chunk', model: id, text }); };
  let remaining = ids.length;
  const children = [];

  // Persist the turn up front (responses empty for now) so the conversation
  // appears in the sidebar the moment you hit send, not only after all three
  // models finish. `collected` is stored by reference, so re-saving on
  // completion captures the streamed text. Temporary chats are never saved.
  let conv = null;
  if (!temporary) {
    conv = saveTurn(conversationId, prompt, collected, attachments);
    emit({ type: 'saved', conversationId: conv.id, title: conv.title, turnIndex: conv.turns.length - 1 });
  }

  for (const id of ids) {
    const cfg = MODELS[id];
    const child = spawn(cfg.cmd, cfg.args(withHistory(priorTurns, id, basePrompt), {
      images,
      attachments,
      disabledSkills,
      enabledSkills: id === 'codex' ? enabledCodex : undefined,
      model: serviceModels[id],
    }), {
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
        // Capture an error reason from the JSON stream (e.g. rate/usage limit),
        // which CLIs report on stdout, not stderr.
        if (parsed.is_error || parsed.type === 'error' || (parsed.type === 'result' && parsed.subtype && parsed.subtype !== 'success')) {
          const why = parsed.result || parsed.message || parsed.error?.message || parsed.subtype;
          if (why && !err.includes(why)) err += `${why}`;
        }
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
        if (conv) { conv.updatedAt = new Date().toISOString(); saveConv(conv); } // persist completed responses
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

// A long-running process can't spawn a CLI that updated underneath it (the
// binary/symlink is swapped). Watch the CLIs and exit on change so launchd's
// KeepAlive respawns a fresh process that resolves the new binary.
function whichPath(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}
function cliFingerprint() {
  const cmds = [...new Set(Object.values(MODELS).map((m) => m.cmd))];
  return cmds.map((c) => {
    try { const s = fs.statSync(whichPath(c)); return `${c}:${s.mtimeMs}:${s.size}`; } catch { return `${c}:none`; }
  }).join('|');
}
let cliBaseline = cliFingerprint();
setInterval(() => {
  const now = cliFingerprint();
  if (now !== cliBaseline && !now.includes(':none')) { // skip mid-update (binary briefly absent)
    console.log('CLI updated; restarting.');
    process.exit(0);
  }
  if (!now.includes(':none')) cliBaseline = now;
}, 30000);

app.listen(PORT, () => console.log(`Prism on http://localhost:${PORT}`));
