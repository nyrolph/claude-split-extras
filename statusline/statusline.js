#!/usr/bin/env node
// Claude Code status line: split | model | effort | used tokens | context-to-autocompact | task progress bar | PR # | session id
// Receives session JSON on stdin (https://docs.claude.com/en/docs/claude-code/statusline)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Honour CLAUDE_CONFIG_DIR so this one file works from any profile (split);
// without it, tasks/ and settings.json would always be read from the home
// profile and the task progress bar would vanish inside a split.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PR_CACHE = path.join(CLAUDE_DIR, 'cache', 'statusline-pr.json');
const PR_TTL_FOUND_MS = 10 * 60 * 1000; // re-check a known PR every 10 min
const PR_TTL_NONE_MS = 90 * 1000;       // re-check "no PR yet" every 90 s

// Claude Code isn't documented to expose its exact auto-compact trigger point
// in the statusline JSON, so this mirrors its widely-observed behavior of
// auto-compacting once true context usage reaches ~92% of the model's
// context window (leaving headroom for the compaction summary itself).
const AUTO_COMPACT_THRESHOLD = 0.92;

// ---- ANSI helpers ----------------------------------------------------------
const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s) => c('2', s);
const cyan = (s) => c('36', s);
const magenta = (s) => c('35', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const blue = (s) => c('34', s);

function bar(ratio, width) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// ---- segments --------------------------------------------------------------
// Every profile shares this one file, so the split label is derived from the
// config dir the CLI was launched with: `~/.claude` (or an unset
// CLAUDE_CONFIG_DIR) is the home profile, anything else is a split named after
// its own directory. Colour comes from the split's position in the registry, so
// every split on the machine gets a distinct one (hashing the name collides
// with as few as four names). Cyan and magenta lead the model and effort
// segments, so they are kept out of the front of the palette.
const SPLIT_COLORS = ['1;33', '1;32', '1;34', '1;31', '1;35'];
function splitSegment() {
  const home = path.join(os.homedir(), '.claude');
  let dir = home;
  try { dir = path.resolve(CLAUDE_DIR); } catch { /* keep home */ }
  if (dir.toLowerCase() === home.toLowerCase()) return c('1;37', 'home');
  const name = path.basename(dir) || 'home';
  let idx = 0;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'registry.json'), 'utf8'));
    const i = (reg.splits || []).indexOf(name);
    if (i >= 0) idx = i;
  } catch { /* no registry, or a split not listed in it — first colour */ }
  return c(SPLIT_COLORS[idx % SPLIT_COLORS.length], name);
}

function effortSegment(data) {
  let effort = data.effort_level || data.effortLevel || null;
  if (!effort) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
      effort = settings.effortLevel || null;
    } catch { /* ignore */ }
  }
  return effort ? magenta(effort) : null;
}

function tokensSegment(data) {
  let used = null;
  // Prefer context info if the harness provides it directly
  const ctx = data.context_window || data.context;
  if (ctx) {
    used = ctx.used_tokens ?? ctx.tokens_used ?? ctx.total_tokens ?? ctx.input_tokens ?? null;
  }
  if (used == null && data.transcript_path) used = tokensFromTranscript(data.transcript_path);
  if (used == null) return null;

  // Prefer the harness-reported window size; only guess from the model ID
  // when it's absent.
  const modelId = (data.model && data.model.id) || '';
  const max = (ctx && ctx.context_window_size) ||
    (/\[1m\]/i.test(modelId) ? 1_000_000 : 200_000);
  const pct = Math.round((used / max) * 100);
  const color = pct >= 80 ? red : pct >= 50 ? yellow : green;
  return color(`${fmtTokens(used)} tok ${pct}%`);
}

function tokensFromTranscript(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.isSidechain) continue;
        const u = entry.message && entry.message.usage;
        if (!u || u.input_tokens == null) continue;
        return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
               (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      } catch { /* partial/foreign line */ }
    }
  } catch { /* no transcript yet */ }
  return null;
}

function ctxSegment(data) {
  const ctx = data.context_window;
  if (!ctx) return null;

  // Prefer the harness's own pre-calculated "% of window used"; fall back to
  // raw token counts vs. the window size if that's all that's available.
  let rawPct = null;
  if (typeof ctx.used_percentage === 'number') {
    rawPct = ctx.used_percentage;
  } else if (ctx.context_window_size) {
    const used = (ctx.total_input_tokens || 0) + (ctx.total_output_tokens || 0);
    rawPct = (used / ctx.context_window_size) * 100;
  }
  if (rawPct == null) return null;

  // Re-base that percentage against the auto-compact trigger point (not the
  // raw window size), so 100% means auto-compact is imminent.
  const pct = Math.min(100, Math.round(rawPct / AUTO_COMPACT_THRESHOLD));
  const color = pct >= 90 ? red : pct >= 70 ? yellow : green;
  return color(`ctx ${String(pct).padStart(2, '0')}%`);
}

function taskSegment(data) {
  try {
    const dir = path.join(CLAUDE_DIR, 'tasks', data.session_id);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return null;
    let total = 0, done = 0, active = null;
    for (const f of files) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!t.status) continue;
        total++;
        if (t.status === 'completed') done++;
        else if (t.status === 'in_progress' && !active) active = t.activeForm || t.subject;
      } catch { /* skip unreadable task */ }
    }
    if (!total) return null;
    let seg = `${bar(done / total, 10)} ${done}/${total}`;
    if (active) {
      if (active.length > 32) active = active.slice(0, 31) + '…';
      seg += ' ' + dim(active);
    }
    return green(seg);
  } catch {
    return null;
  }
}

function prSegment(data) {
  const cwd = (data.workspace && data.workspace.current_dir) || data.cwd;
  if (!cwd) return null;
  const branch = gitBranch(cwd);
  if (!branch) return null;

  const key = `${cwd}|${branch}`;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(PR_CACHE, 'utf8')); } catch { /* no cache yet */ }

  const hit = cache[key];
  const ttl = hit && hit.pr ? PR_TTL_FOUND_MS : PR_TTL_NONE_MS;
  let pr;
  if (hit && Date.now() - hit.ts < ttl) {
    pr = hit.pr;
  } else {
    pr = null;
    try {
      const out = execSync('gh pr view --json number --jq .number', {
        cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      }).toString().trim();
      if (/^\d+$/.test(out)) pr = Number(out);
    } catch { /* gh missing, offline, or no PR */ }
    try {
      cache[key] = { pr, ts: Date.now() };
      fs.mkdirSync(path.dirname(PR_CACHE), { recursive: true });
      fs.writeFileSync(PR_CACHE, JSON.stringify(cache));
    } catch { /* cache write is best-effort */ }
  }
  return pr ? blue(`PR #${pr}`) : null;
}

function sessionSegment(data) {
  return data.session_id ? dim(data.session_id) : null;
}

function gitBranch(cwd) {
  try {
    let dir = cwd;
    for (let i = 0; i < 30; i++) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) { // worktree: ".git" is a pointer file
          const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return ref ? ref[1] : null; // detached HEAD -> no PR lookup
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* not a repo */ }
  return null;
}

// ---- main ------------------------------------------------------------------
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch { /* render what we can */ }

  const segments = [
    splitSegment(),
    cyan((data.model && data.model.display_name) || 'Claude'),
    effortSegment(data),
    tokensSegment(data),
    ctxSegment(data),
    taskSegment(data),
    prSegment(data),
    sessionSegment(data),
  ].filter(Boolean);

  process.stdout.write(segments.join(dim(' │ ')));
});
