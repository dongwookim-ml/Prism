const express = require('express');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Agentic CLIs run with this as their working root so they never touch real projects.
const SCRATCH = path.join(os.tmpdir(), 'aggai-scratch');
// macOS periodically purges $TMPDIR; a spawn with a missing cwd fails with
// ENOENT. Re-create the scratch dir before every use, not just at startup.
function ensureScratch() { fs.mkdirSync(SCRATCH, { recursive: true }); return SCRATCH; }
ensureScratch();

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
    .filter((c) => c && c.id && (Array.isArray(c.groups) || Array.isArray(c.turns))) // ignore non-conversation files
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ---- tree-of-thoughts model ----
// A conversation is a forest of response nodes. Each node has its own parentId
// (the answer it continues from). A "group" is one prompt expansion: one node
// per answering model, created together. Branching from a single answer makes
// all the new nodes share that parent (convergent); continuing from a prompt (or
// the last group) makes each new node continue its own model's answer (parallel
// lineages). A node's context is the prompt+answer chain from it up to a root.
const SUMMARY_MARKER = '<<<SUMMARY>>>';

// First sentence (or ~140 chars) of a text, used as a fallback card summary.
function firstSentence(s) {
  const t = String(s || '').replace(/\x1e/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.*?[.!?。！？](\s|$)/);
  let out = (m ? m[0] : t).trim();
  if (out.length > 140) out = out.slice(0, 140).trim() + '…';
  return out;
}

// Turn a CLI's failure output into one concise, actionable line instead of a
// full stack trace (e.g. Gemini's deprecated-tier auth error).
function cliErrorHint(id, err) {
  const e = String(err || '');
  if (/IneligibleTier|no longer supported|Antigravity|Gemini Code Assist for individuals/i.test(e))
    return 'Gemini sign-in is no longer supported — Google ended the free Gemini CLI tier (oauth-personal). Re-authenticate the gemini CLI (e.g. a Gemini API key) or turn Gemini off in Settings → Default models.';
  if (/Error authenticating|not (logged|signed) in|requires? (login|authentication)|please sign in|sign in to view|API key|credential|invalid_grant|\b40[13]\b|unauthor/i.test(e))
    return `${id} isn't signed in. Log in to its CLI, then retry.`;
  const line = e.split('\n').map((s) => s.trim()).find((s) => s && !/^Warning:|YOLO mode|Ripgrep|256-color|^An unexpected/i.test(s));
  return line ? line.slice(0, 200) : '';
}

// Antigravity (agy) prints one of these when it isn't signed in. It can also
// block waiting for an interactive sign-in, which Prism can't do, so we detect
// the message in its output, kill the process, and return a clean note instead.
const AGY_LOGIN_RE = /please sign in|not (signed|logged) in|sign in to (view|use)|launch the cli without arguments to sign in/i;
const AGY_LOGIN_MESSAGE = '[Gemini not signed in] Antigravity (agy) needs an interactive sign-in, which Prism can\'t do. Run `agy` in a terminal (no arguments) to sign in, then retry. Or turn Gemini off in Settings.';

// Each model appends its own one-sentence summary after a marker; split it out.
function parseSummary(text) {
  const t = String(text || '');
  const i = t.lastIndexOf(SUMMARY_MARKER);
  if (i < 0) return { body: t.trim(), summary: firstSentence(t) };
  const body = t.slice(0, i).trim();
  let summary = t.slice(i + SUMMARY_MARKER.length).trim().split('\n')[0].trim();
  if (!summary) summary = firstSentence(body);
  return { body, summary };
}

// Normalize any stored conversation into the current node tree (v3). Each node
// carries its own parentId (the response it continues from), so a group's three
// answers can either share one parent (branch from a single answer) or each
// continue their own model's thread (three parallel lineages). Handles:
//   v1 (linear `turns`)         -> per-model lineage, preserving each model's own thread
//   v2 (`group.parentNodeId`)   -> every node inherits that single shared parent
// Stable ids so selection survives reloads. Non-destructive: the file is only
// rewritten in this format when the conversation is next edited.
function normalizeConv(conv) {
  if (!conv) return null;
  let selected = conv.selected || null;
  if (typeof selected === 'string') selected = { kind: 'node', id: selected };

  if (Array.isArray(conv.groups)) {
    for (const g of conv.groups) {
      for (const n of g.nodes) if (n.parentId === undefined) n.parentId = g.parentNodeId || null; // v2 -> per-node
      delete g.parentNodeId;
    }
    conv.version = 3; conv.selected = selected;
    conv.mode = conv.mode === 'linear' ? 'linear' : 'tree'; // group-based chats default to tree
    return conv;
  }

  const groups = [];
  const lastByModel = {}; // model -> its most recent node id, for per-model lineage
  let lastAny = null;
  (conv.turns || []).forEach((t, i) => {
    const g = {
      id: `${conv.id}-g${i}`, prompt: t.prompt || '', attachments: t.attachments || [],
      ts: t.ts, nodes: [], synthesis: t.synthesis, critiques: t.critiques, critiquesOf: t.critiquesOf,
    };
    const resp = t.responses || {};
    for (const model of Object.keys(resp)) {
      const text = String(resp[model] || '');
      if (!text.trim()) continue;
      const { body, summary } = parseSummary(text);
      const id = `${conv.id}-n${i}-${model}`;
      g.nodes.push({ id, model, text: body, summary, ts: t.ts, parentId: lastByModel[model] || lastAny || null });
    }
    for (const n of g.nodes) { lastByModel[n.model] = n.id; lastAny = n.id; }
    groups.push(g);
  });
  return {
    id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
    version: 3, mode: 'linear', selected, groups, // legacy turn-based chats were authored in linear mode
  };
}

const findNode = (conv, id) => {
  for (const g of (conv.groups || [])) for (const n of g.nodes) if (n.id === id) return { group: g, node: n };
  return {};
};
const findGroup = (conv, id) => (conv.groups || []).find((g) => g.id === id);

// Format an explicit context chain (root..parent of {prompt,text}) ahead of the
// current prompt. The client builds the chain from its in-memory tree, so this
// works identically for saved and temporary chats. All models in a group get the
// same context (the selected line of thought).
function formatContext(context, current) {
  const clean = (s) => String(s || '').replace(/\x1e/g, '\n').trim();
  const hist = (context || [])
    .filter((e) => clean(e.text))
    .slice(-12)
    .map((e) => {
      let block = `User: ${e.prompt || '[attached files]'}\nAssistant: ${clean(e.text)}`;
      // Opponents' critiques of this answer, only when the client opted in (buildContext).
      const crit = (Array.isArray(e.critiques) ? e.critiques : [])
        .filter((c) => clean(c && c.text))
        .map((c) => `- ${c.by || 'Another assistant'}: ${clean(c.text)}`)
        .join('\n');
      if (crit) block += `\n\nThe other assistants critiqued that answer:\n${crit}`;
      return block;
    })
    .join('\n\n');
  if (!hist) return current;
  return `Earlier in this conversation:\n\n${hist}\n\nReply to the user's new message below, using that context.\n\nUser: ${current}`;
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

// The Gemini pane runs via Antigravity (agy); its "skills" are agy plugins.
// `agy plugin list` prints one plugin per line (best-effort parse; "[disabled]"
// marks a disabled one). No plugins => empty.
async function geminiSkills() {
  const { stdout } = await run('agy', ['plugin', 'list']);
  if (/no imported plugins/i.test(stdout)) return [];
  const skills = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || /^(imported plugins|plugins?:|usage)/i.test(line)) continue;
    const m = line.match(/^[-*•]?\s*([A-Za-z0-9._@/-]+)/);
    if (!m) continue;
    skills.push({ name: m[1], description: '', enabled: !/disabled/i.test(line) });
  }
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

// Default Antigravity model for the Gemini pane (see `agy models`).
const GEMINI_MODEL = 'Gemini 3.1 Pro (High)';

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
    // --strict-mcp-config: ignore the user's global ~/.claude.json MCP servers (e.g. the
    // slurm SSH server), which would otherwise auto-connect on every call and can hang.
    args: (p, ctx) => {
      const base = ['-p', filePreamble(ctx.attachments) + p, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--dangerously-skip-permissions', '--strict-mcp-config'];
      if (ctx.model) base.push('--model', ctx.model);
      const disabled = ctx.disabledSkills || [];
      return disabled.length ? [...base, '--disallowedTools', ...disabled.map((n) => `Skill(${n})`)] : base;
    },
    parse: (o) => {
      if (o.type !== 'stream_event') return null;
      const ev = o.event;
      // Claude emits one text block per assistant message; between tool calls
      // there are several, so prefix each new text block with U+001E. The client
      // then renders them as separate paragraphs (earlier = muted reasoning, last
      // = the answer), the same way it handles Codex's messages.
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') return '\x1e';
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return ev.delta.text;
      return null;
    },
  },
  gemini: {
    // Google ended the free Gemini CLI tier, so this pane runs Antigravity (agy),
    // which serves Gemini models. --print: one-shot non-interactive answer (plain
    // text). A --model is REQUIRED (the default-model path hangs headlessly).
    label: 'Gemini (Antigravity)',
    cmd: 'agy',
    args: (p, ctx) => {
      const a = ['--print', filePreamble(ctx.attachments) + p,
        '--model', ctx.model || GEMINI_MODEL, '--dangerously-skip-permissions', '--print-timeout', '4m'];
      if (ctx.attachments && ctx.attachments.length) a.push('--add-dir', '.'); // expose the upload dir
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

const app = express();
app.use(express.json({ limit: '30mb' })); // room for base64-encoded file uploads
app.use(express.static(path.join(__dirname, 'public')));

app.get('/models', (_req, res) => {
  res.json(Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })));
});

app.get('/conversations', (_req, res) => res.json(listConvs()));

app.get('/conversations/:id', (req, res) => {
  const c = normalizeConv(loadConv(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

app.delete('/conversations/:id', (req, res) => {
  try { fs.unlinkSync(convPath(req.params.id)); } catch {}
  res.json({ ok: true });
});

// Delete a group (a prompt expansion) and the whole subtree branched from any of
// its nodes. A group is a child if any of its nodes' parentId points at a node
// being removed. Selection is cleared if it pointed into the removed subtree.
app.delete('/conversations/:id/groups/:groupId', (req, res) => {
  const c = normalizeConv(loadConv(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const removed = new Set();
  const collect = (gid) => {
    const g = findGroup(c, gid);
    if (!g || removed.has(gid)) return;
    removed.add(gid);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const child of c.groups.filter((x) => x.nodes.some((n) => ids.has(n.parentId)))) collect(child.id);
  };
  collect(req.params.groupId);
  c.groups = c.groups.filter((g) => !removed.has(g.id));
  if (c.selected) {
    const ok = c.selected.kind === 'group' ? findGroup(c, c.selected.id) : findNode(c, c.selected.id).node;
    if (!ok) c.selected = null;
  }
  c.updatedAt = new Date().toISOString();
  saveConv(c);
  res.json({ ok: true });
});

// Delete a single answer node (e.g. one model's response in a linear turn).
// Its children are reparented to its parent so the lineage stays connected; an
// emptied group is removed.
app.delete('/conversations/:id/nodes/:nodeId', (req, res) => {
  const c = normalizeConv(loadConv(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const { group, node } = findNode(c, req.params.nodeId);
  if (!node) return res.status(404).json({ error: 'not found' });
  for (const g of c.groups) for (const n of g.nodes) if (n.parentId === node.id) n.parentId = node.parentId || null;
  group.nodes = group.nodes.filter((n) => n.id !== node.id);
  if (!group.nodes.length) c.groups = c.groups.filter((g) => g !== group);
  if (c.selected && c.selected.kind === 'node' && c.selected.id === node.id) c.selected = null;
  c.updatedAt = new Date().toISOString();
  saveConv(c);
  res.json({ ok: true });
});

// Set (or clear, with empty body) the current selection: a response node (the
// next prompt branches all models from that one answer) or a prompt/group (each
// model continues its own answer in that group). null = continue from the last
// group, per model.
app.post('/conversations/:id/select', (req, res) => {
  const c = normalizeConv(loadConv(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const { kind, id } = req.body || {};
  let sel = null;
  if (kind === 'node' && findNode(c, id).node) sel = { kind, id };
  else if (kind === 'group' && findGroup(c, id)) sel = { kind, id };
  else if (kind) return res.status(400).json({ error: 'no such selection' });
  c.selected = sel;
  c.updatedAt = new Date().toISOString();
  saveConv(c);
  res.json({ ok: true, selected: c.selected });
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
  res.json({ defaultModels: dm.length ? dm : Object.keys(MODELS), models: s.models || {}, customInstructions: s.customInstructions || '' });
});

app.post('/settings', async (req, res) => {
  const claude = Array.isArray(req.body?.claude) ? req.body.claude.map(String) : null;
  const gemini = Array.isArray(req.body?.gemini) ? req.body.gemini.map(String) : null;
  const codex = Array.isArray(req.body?.codex) ? req.body.codex.map(String) : null;
  const defaultModels = Array.isArray(req.body?.defaultModels) ? req.body.defaultModels.filter((id) => MODELS[id]) : null;
  const serviceModels = (req.body?.models && typeof req.body.models === 'object') ? req.body.models : null;
  const customInstructions = typeof req.body?.customInstructions === 'string' ? req.body.customInstructions : null;

  if (customInstructions !== null) {
    const settings = loadSettings();
    settings.customInstructions = customInstructions.trim().slice(0, 8000);
    saveSettings(settings);
  }

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
  // Gemini pane = Antigravity (agy); its skills are agy plugins, toggled via agy.
  if (gemini) {
    const want = new Set(gemini);
    for (const s of await geminiSkills()) {
      const on = want.has(s.name);
      if (on !== s.enabled) await run('agy', ['plugin', on ? 'enable' : 'disable', s.name]);
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
  const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--strict-mcp-config', '--disallowedTools', 'Skill', 'Task', 'Bash'],
    { cwd: ensureScratch(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); // decode multibyte (UTF-8) across chunk boundaries
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
  const groupId = req.body?.groupId || null;
  const clean = (s) => String(s || '').replace(//g, '\n').trim();
  const answered = Object.keys(responses).filter((id) => MODELS[id] && clean(responses[id]));
  if (answered.length < 2) return res.status(400).json({ error: 'need at least two responses' });
  // Optional: critique a single target model's answer (critics = the others).
  const target = (req.body?.target && MODELS[req.body.target] && answered.includes(req.body.target)) ? req.body.target : null;
  const ids = target ? answered.filter((id) => id !== target) : answered;

  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  const critiques = {};
  let remaining = ids.length;
  const children = [];
  for (const id of ids) {
    const cfg = MODELS[id];
    const subjects = (target ? [target] : answered.filter((o) => o !== id))
      .map((o) => `### ${MODELS[o].label.split(' ')[0]}\n${clean(responses[o])}`).join('\n\n');
    const what = target ? `that assistant's answer` : `the other assistants' answers`;
    const critPrompt = `Several AI assistants answered the same question.\n\nQuestion:\n${prompt || '(see answers)'}\n\nYour answer:\n${clean(responses[id])}\n\n${target ? 'Another assistant answered' : 'The other assistants answered'}:\n\n${subjects}\n\nCritique ${what}: factual errors, questionable claims, omissions, and where it is weaker or stronger than yours. Be specific and fair; concede good points. Concise markdown, same language as the answers. Do not restate your own answer. Do not use markdown headings (#); when addressing multiple assistants, start each with a bold name line like **Gemini:**.`;
    const child = spawn(cfg.cmd, cfg.args(critPrompt, {}), { cwd: ensureScratch(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '', err = '';
    critiques[id] = '';
    child.stdout.setEncoding('utf8'); // decode multibyte (UTF-8) across chunk boundaries
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
      if (code && code !== 0) { const hint = cliErrorHint(id, err); emit({ type: 'chunk', model: id, text: `\n[${id} couldn't respond]${hint ? ' ' + hint : ` (exit ${code})`}` }); }
      emit({ type: 'done', model: id });
      if (--remaining === 0) {
        if (conversationId && groupId) {
          const c = normalizeConv(loadConv(conversationId));
          const g = c && findGroup(c, groupId);
          if (g) {
            if (target) { g.critiquesOf = g.critiquesOf || {}; g.critiquesOf[target] = critiques; }
            else g.critiques = critiques;
            c.updatedAt = new Date().toISOString();
            saveConv(c);
          }
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
  const groupId = req.body?.groupId || null;

  const cmpPrompt = `Three AI assistants answered the same question. Compare them at a semantic level, not word by word.\n\nQuestion:\n${prompt || '(inferred from the answers)'}\n\nAnswers:\n${parts}\n\nOutput ONLY this JSON between <<<R>>> and <<</R>>> tags, with string values in the same language as the answers:\n{"consensus":["point all or most agree on", ...],"differences":[{"topic":"short topic","positions":[{"model":"claude|gemini|codex","stance":"what this model says"}]}],"unique":[{"model":"claude|gemini|codex","point":"point only this model raised"}]}\nKeep each string short. Omit unique if none. Only include models that actually answered.`;
  const child = spawn('claude', ['-p', cmpPrompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--strict-mcp-config', '--disallowedTools', 'Skill', 'Task', 'Bash'],
    { cwd: ensureScratch(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); // decode multibyte (UTF-8) across chunk boundaries
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
    // Persist the synthesis on its group so it survives reloads.
    if (conversationId && groupId) {
      const c = normalizeConv(loadConv(conversationId));
      const g = c && findGroup(c, groupId);
      if (g) { g.synthesis = synthesis; c.updatedAt = new Date().toISOString(); saveConv(c); }
    }
    res.json({ text: synthesis });
  });
  res.on('close', () => { if (!res.writableEnded) child.kill('SIGTERM'); });
});

app.post('/ask', (req, res) => {
  const prompt = (req.body?.prompt || '').toString().trim();
  const conversationId = req.body?.conversationId || null;
  // Per-model parent node + context chain, built by the client. A convergent
  // branch repeats the same parent/context for every model; a parallel branch
  // gives each model its own. Missing => null parent, empty context.
  const nodeParents = (req.body?.nodeParents && typeof req.body.nodeParents === 'object') ? req.body.nodeParents : {};
  const contexts = (req.body?.contexts && typeof req.body.contexts === 'object') ? req.body.contexts : {};
  const temporary = !!req.body?.temporary; // ephemeral chat: never saved to disk
  const mode = req.body?.mode === 'tree' ? 'tree' : 'linear'; // per-chat mode, set when the chat is created
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!prompt && !files.length) return res.status(400).json({ error: 'empty prompt' });

  // Uploaded files are written into a per-request dir that becomes each CLI's
  // working directory, so the agents can read/view them. They're named in the
  // prompt; images are also handed to Codex via -i.
  let cwd = ensureScratch();
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
  // Ask each model to end with a one-sentence summary used as its tree card.
  const summarized = `${basePrompt}\n\nAfter your full answer, on a new final line output exactly "${SUMMARY_MARKER}" followed by one concise sentence (in the same language as your answer) that summarizes your answer. Use that marker only once, at the very end.`;

  // Apply app-scoped Claude/Codex skill selections.
  const skillSettings = loadSettings().skills || {};
  const enabledClaude = skillSettings.claude; // undefined => all enabled
  const disabledSkills = enabledClaude ? claudeSkills().map((s) => s.name).filter((n) => !enabledClaude.includes(n)) : [];
  const allCodexSkills = codexSkills();
  const enabledCodex = skillSettings.codex
    ? allCodexSkills.filter((s) => skillSettings.codex.includes(s.name))
    : allCodexSkills;

  // Per-service base model override (empty => CLI default).
  const serviceModels = loadSettings().models || {};

  // Standing user instructions (personalization), prepended to every prompt.
  const ci = (loadSettings().customInstructions || '').trim();
  const ciPreamble = ci ? `Standing instructions from the user (apply to every reply):\n${ci}\n\n` : '';

  // Stream newline-delimited JSON events back to the browser as they happen.
  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  // Models for this turn: explicit (from @mentions) -> saved defaults -> all.
  const requested = Array.isArray(req.body?.models) ? req.body.models.filter((id) => MODELS[id]) : [];
  const defaultModels = (loadSettings().defaultModels || []).filter((id) => MODELS[id]);
  const ids = requested.length ? requested : (defaultModels.length ? defaultModels : Object.keys(MODELS));
  const collected = Object.fromEntries(ids.map((id) => [id, ''])); // full text per model
  const emitChunk = (id, text) => { collected[id] += text; emit({ type: 'chunk', model: id, text }); };
  let remaining = ids.length;
  const children = [];
  const loginRequired = {}; // model -> true once we see an agy sign-in prompt

  // Append a new group (one node per model) to the conversation tree up front so
  // it appears immediately; node text is filled in on completion. The node
  // objects are held by reference, so re-saving captures the parsed answers.
  // Temporary chats are never persisted (the client holds their tree in memory).
  const now = new Date().toISOString();
  const groupId = crypto.randomUUID();
  const nodeIds = Object.fromEntries(ids.map((id) => [id, crypto.randomUUID()]));
  let conv = null, group = null;
  if (!temporary) {
    conv = (conversationId && normalizeConv(loadConv(conversationId))) || null;
    if (!conv) {
      const title = basePrompt.split('\n')[0].slice(0, 60) || (attachments.length ? attachments.join(', ').slice(0, 60) : 'Untitled');
      conv = { id: crypto.randomUUID(), title, createdAt: now, version: 3, mode, selected: null, groups: [] };
    }
    group = { id: groupId, prompt, attachments, ts: now,
      nodes: ids.map((id) => ({ id: nodeIds[id], model: id, text: '', summary: '', ts: now, parentId: nodeParents[id] || null })) };
    conv.groups.push(group);
    conv.updatedAt = now;
    saveConv(conv);
    emit({ type: 'saved', conversationId: conv.id, title: conv.title, groupId, nodes: nodeIds });
  }

  for (const id of ids) {
    const cfg = MODELS[id];
    const child = spawn(cfg.cmd, cfg.args(ciPreamble + formatContext(Array.isArray(contexts[id]) ? contexts[id] : [], summarized), {
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

    child.stdout.setEncoding('utf8'); // decode multibyte (UTF-8) across chunk boundaries
    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!cfg.parse) {
          if (loginRequired[id]) continue; // signed-out: drop the interactive login text
          if (id === 'gemini' && !collected[id].trim() && AGY_LOGIN_RE.test(line)) { loginRequired[id] = true; child.kill('SIGTERM'); continue; }
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

    child.stderr.on('data', (d) => {
      err += d.toString();
      if (id === 'gemini' && !collected[id].trim() && !loginRequired[id] && AGY_LOGIN_RE.test(err)) { loginRequired[id] = true; child.kill('SIGTERM'); }
    });

    child.on('error', (e) => {
      emitChunk(id, `[cannot start "${cfg.cmd}": ${e.message}. Is it installed and logged in?]`);
    });

    child.on('close', (code) => {
      if (loginRequired[id]) {
        collected[id] = ''; // discard the raw login prompt; return just a clean note
        emitChunk(id, AGY_LOGIN_MESSAGE);
      } else {
        if (!cfg.parse && out.trim()) emitChunk(id, out); // flush tail
        if (code && code !== 0) {
          const hint = cliErrorHint(id, err);
          emitChunk(id, `\n[${id} couldn't respond]${hint ? ' ' + hint : ` (exit ${code})`}`);
        }
      }
      // Split the trailing one-sentence summary off the answer for the tree card.
      const { body, summary } = parseSummary(collected[id]);
      if (group) { const n = group.nodes.find((x) => x.model === id); if (n) { n.text = body; n.summary = summary; } }
      emit({ type: 'done', model: id, body, summary });
      if (--remaining === 0) {
        if (conv) { conv.updatedAt = new Date().toISOString(); saveConv(conv); } // persist completed answers
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

// Re-run a single answer in place (the regenerate button): same prompt + context
// as the original, replacing the node's text/summary. The client only allows this
// for a node with no follow-ups, so reparenting is never needed.
app.post('/regenerate', (req, res) => {
  const model = req.body?.model;
  if (!MODELS[model]) return res.status(400).json({ error: 'unknown model' });
  const cfg = MODELS[model];
  const conversationId = req.body?.conversationId || null;
  const groupId = req.body?.groupId || null;
  const nodeId = req.body?.nodeId || null;
  const temporary = !!req.body?.temporary;
  const prompt = (req.body?.prompt || '').toString().trim();
  const context = Array.isArray(req.body?.context) ? req.body.context : [];
  if (!prompt) return res.status(400).json({ error: 'empty prompt' });

  const summarized = `${prompt}\n\nAfter your full answer, on a new final line output exactly "${SUMMARY_MARKER}" followed by one concise sentence (in the same language as your answer) that summarizes your answer. Use that marker only once, at the very end.`;

  // Same skill / model / personalization settings as /ask.
  const settings = loadSettings();
  const skillSettings = settings.skills || {};
  const enabledClaude = skillSettings.claude;
  const disabledSkills = enabledClaude ? claudeSkills().map((s) => s.name).filter((n) => !enabledClaude.includes(n)) : [];
  const enabledCodex = skillSettings.codex ? codexSkills().filter((s) => skillSettings.codex.includes(s.name)) : codexSkills();
  const serviceModels = settings.models || {};
  const ci = (settings.customInstructions || '').trim();
  const ciPreamble = ci ? `Standing instructions from the user (apply to every reply):\n${ci}\n\n` : '';

  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');
  let collected = '';
  const emitChunk = (text) => { collected += text; emit({ type: 'chunk', model, text }); };

  const child = spawn(cfg.cmd, cfg.args(ciPreamble + formatContext(context, summarized), {
    attachments: [], images: [], disabledSkills,
    enabledSkills: model === 'codex' ? enabledCodex : undefined,
    model: serviceModels[model],
  }), { cwd: ensureScratch(), stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '', err = '', loginRequired = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d.toString();
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl); out = out.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!cfg.parse) {
        if (loginRequired) continue;
        if (model === 'gemini' && !collected.trim() && AGY_LOGIN_RE.test(line)) { loginRequired = true; child.kill('SIGTERM'); continue; }
        emitChunk(line + '\n');
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      if (parsed.is_error || parsed.type === 'error' || (parsed.type === 'result' && parsed.subtype && parsed.subtype !== 'success')) {
        const why = parsed.result || parsed.message || parsed.error?.message || parsed.subtype;
        if (why && !err.includes(why)) err += `${why}`;
      }
      const text = cfg.parse(parsed);
      if (text) emitChunk(text);
    }
  });
  child.stderr.on('data', (d) => {
    err += d.toString();
    if (model === 'gemini' && !collected.trim() && !loginRequired && AGY_LOGIN_RE.test(err)) { loginRequired = true; child.kill('SIGTERM'); }
  });
  child.on('error', (e) => emitChunk(`[cannot start "${cfg.cmd}": ${e.message}. Is it installed and logged in?]`));
  child.on('close', (code) => {
    if (loginRequired) {
      collected = '';
      emitChunk(AGY_LOGIN_MESSAGE);
    } else {
      if (!cfg.parse && out.trim()) emitChunk(out);
      if (code && code !== 0) {
        const hint = cliErrorHint(model, err);
        emitChunk(`\n[${model} couldn't respond]${hint ? ' ' + hint : ` (exit ${code})`}`);
      }
    }
    const { body, summary } = parseSummary(collected);
    if (!temporary && conversationId && groupId && nodeId) {
      const c = normalizeConv(loadConv(conversationId));
      const g = c && findGroup(c, groupId);
      const n = g && g.nodes.find((x) => x.id === nodeId);
      if (n) { n.text = body; n.summary = summary; c.updatedAt = new Date().toISOString(); saveConv(c); }
    }
    emit({ type: 'done', model, body, summary });
    res.end();
  });
  res.on('close', () => { if (!res.writableEnded) child.kill('SIGTERM'); });
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
