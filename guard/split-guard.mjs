#!/usr/bin/env node
// split-guard.mjs - PreToolUse hook enforcing claude-split territory.
// Spec: ~/.claude-splits/docs/specs/2026-08-19-split-isolation-guard-design.md
//
// Contract: deny = JSON decision on stdout + exit 0; allow = silent exit 0;
// any internal error = exit 1 with stderr (non-blocking: fail open, loudly).
// CLAUDE_SPLIT_GUARD_OFF=1 disables the guard for the invocation.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();
const SPLITS_ROOT = path.join(HOME, '.claude-splits');
const HOME_CLAUDE = path.join(HOME, '.claude');

function foldersFile() {
  if (process.env.CLAUDE_SPLIT_GUARD_FOLDERS) return process.env.CLAUDE_SPLIT_GUARD_FOLDERS;
  const base = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  return path.join(base, 'claude-split', 'folders.json');
}

function registryFile() {
  return process.env.CLAUDE_SPLIT_GUARD_REGISTRY || path.join(SPLITS_ROOT, 'registry.json');
}

// PowerShell writes these files and may leave a UTF-8 BOM; JSON.parse rejects it.
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

// The registry is load-bearing for identity: a wrong fallback would silently
// flip a split session to 'home' and deny it its own territory. Unreadable
// means the whole guard must fail open loudly (exit 1) instead.
function readJsonStrict(file, label) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`cannot read ${label} (${file}): ${e.message}`); }
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

// Drive aliases from subst.exe ("D:\: => X:\Base"), lowercased, no trailing sep.
// CLAUDE_SPLIT_GUARD_SUBST_JSON ({"d:":"x:\\base"}) replaces the lookup in tests.
function substMap() {
  const inj = process.env.CLAUDE_SPLIT_GUARD_SUBST_JSON;
  if (inj !== undefined) {
    try {
      const out = {};
      for (const [k, v] of Object.entries(JSON.parse(inj))) {
        out[k.toLowerCase()] = String(v).replace(/[\\/]+$/, '').toLowerCase();
      }
      return out;
    } catch { return {}; }
  }
  const out = {};
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'subst.exe');
    for (const line of execFileSync(exe, { encoding: 'utf8' }).split(/\r?\n/)) {
      const m = /^([A-Za-z]):\\?:\s+=>\s+(.+)$/.exec(line);
      if (m) out[(m[1] + ':').toLowerCase()] = m[2].trim().replace(/[\\/]+$/, '').toLowerCase();
    }
  } catch { /* no subst mappings available */ }
  return out;
}

// Canonical form: absolute, subst-expanded, lowercase, backslashes, no trailing sep.
function norm(p, cwd, subst) {
  if (!p) return '';
  p = String(p);
  p = p.replace(/^\\\\[?.]\\/, ''); // \\?\E:\... and \\.\E:\... are the same path
  if (p === '~') p = HOME;
  else if (/^~[\\/]/.test(p)) p = path.join(HOME, p.slice(2));
  const posix = /^\/([A-Za-z])(\/|$)/.exec(p); // git-bash form /x/Base/...
  if (posix) p = posix[1] + ':' + (p.slice(2) || '\\');
  p = path.win32.resolve(cwd || process.cwd(), p);
  let low = p.toLowerCase().replace(/[\\/]+$/, '');
  const drive = low.slice(0, 2);
  if (/^[a-z]:$/.test(drive) && subst[drive]) low = subst[drive] + low.slice(2);
  return low;
}

const under = (p, dir) => p === dir || p.startsWith(dir + '\\');

function loadCfg(subst) {
  const folders = readJson(foldersFile(), {});
  const reg = readJsonStrict(registryFile(), 'registry');
  const pins = [];
  for (const [k, v] of Object.entries(folders)) pins.push([norm(k, undefined, subst), String(v)]);
  return {
    splitsRoot: norm(SPLITS_ROOT, undefined, subst),
    homeClaude: norm(HOME_CLAUDE, undefined, subst),
    homeJson: norm(path.join(HOME, '.claude.json'), undefined, subst),
    guardCfgDir: norm(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'claude-split'), undefined, subst),
    registryPath: norm(path.join(SPLITS_ROOT, 'registry.json'), undefined, subst),
    carveOuts: ['ide', 'statusline.js', 'CLAUDE.md']
      .map((x) => norm(path.join(HOME_CLAUDE, x), undefined, subst)),
    splits: new Set((reg.splits || []).map(String)),
    pins,
  };
}

// Owning profile id ('home' or a split name), or null when shared/unowned.
// Config dirs outrank pins; a pin cannot claim territory inside them.
function ownerOf(p, cfg) {
  if (under(p, cfg.splitsRoot)) {
    if (p === cfg.registryPath) return 'home'; // the split map is home-only
    const first = p.slice(cfg.splitsRoot.length + 1).split('\\')[0];
    if (cfg.splits.has(first)) return first;
    return null; // wrapper, guard, docs/, .migration/ are shared
  }
  // Home's top-level state file (~/.claude.json and its .backup siblings)
  // lives beside, not inside, ~/.claude - fence it the same way.
  if (p === cfg.homeJson || p.startsWith(cfg.homeJson + '.')) return 'home';
  // The pin map enumerates every company folder - home-only as well.
  if (under(p, cfg.guardCfgDir)) return 'home';
  if (under(p, cfg.homeClaude)) {
    for (const c of cfg.carveOuts) if (under(p, c)) return null; // ide/, statusline.js, CLAUDE.md
    return 'home';
  }
  let best = null, bestLen = -1;
  for (const [pin, split] of cfg.pins) {
    if (under(p, pin) && pin.length > bestLen) { best = split; bestLen = pin.length; }
  }
  return best;
}

function currentId(cfg, subst) {
  const cd = process.env.CLAUDE_CONFIG_DIR;
  if (!cd) return 'home';
  const p = norm(cd, undefined, subst);
  if (under(p, cfg.splitsRoot)) {
    const first = p.slice(cfg.splitsRoot.length + 1).split('\\')[0];
    if (cfg.splits.has(first)) return first;
  }
  return 'home'; // unknown config dirs are treated like home (spec)
}

// Absolute-path tokens only: X:\..., X:/..., /x/..., ~/... - bare or quoted.
// Relative paths are deliberately ignored (spec: false-positive risk); a bare
// token cut short at a space is a prefix of the real path, which still lands
// in the same territory, so truncation cannot cause a miss inside a pin.
// Shared by the Bash and PowerShell tools: both pass a shell command string,
// and Windows path syntax is the common case for either.
function extractBashPaths(cmd) {
  const found = [];
  const shapes = [
    /[A-Za-z]:[\\/][^\s"'`|;&<>()]*/g,          // drive path, bare
    /(?<![\w./])\/[A-Za-z]\/[^\s"'`|;&<>()]*/g, // git-bash /e/...
    /(?<![\w./])~[\\/][^\s"'`|;&<>()]*/g,       // ~/...
  ];
  for (const re of shapes) for (const m of cmd.matchAll(re)) found.push(m[0]);
  // Quoted spans may contain spaces: take the whole span when it starts as a path.
  for (const m of cmd.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const s = m[1] !== undefined ? m[1] : m[2];
    if (/^([A-Za-z]:[\\/]|\/[A-Za-z]\/|~[\\/])/.test(s)) found.push(s);
  }
  return found;
}

function candidatePaths(toolName, toolInput, cwd) {
  switch (toolName) {
    case 'Read': case 'Edit': case 'Write': return [toolInput.file_path];
    case 'NotebookEdit': return [toolInput.notebook_path];
    case 'Glob': case 'Grep': return [toolInput.path || cwd];
    case 'Bash': case 'PowerShell': return extractBashPaths(String(toolInput.command || ''));
    default: return [];
  }
}

function main() {
  if (process.env.CLAUDE_SPLIT_GUARD_OFF === '1') return 0;
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const cwd = input.cwd || process.cwd();
  const subst = substMap();
  const cfg = loadCfg(subst);
  const me = currentId(cfg, subst);
  for (const raw of candidatePaths(input.tool_name, input.tool_input || {}, cwd)) {
    if (!raw) continue;
    const owner = ownerOf(norm(raw, cwd, subst), cfg);
    if (owner && owner !== me) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `${raw} belongs to another profile; this session is '${me}' (split-guard)`,
        },
      }));
      return 0;
    }
  }
  return 0;
}

try { process.exit(main()); }
catch (e) {
  console.error(`split-guard error (failing open): ${e && e.message ? e.message : e}`);
  process.exit(1);
}
