// Tests for split-guard.mjs. Plain node, no framework: node split-guard.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'split-guard.mjs');
const HOMEDIR = os.homedir();
const CFG = (name) => path.join(HOMEDIR, '.claude-splits', name);

// ---- fixtures ---------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'split-guard-test-'));
const foldersPath = path.join(tmp, 'folders.json');
const registryPath = path.join(tmp, 'registry.json');
fs.writeFileSync(foldersPath, JSON.stringify({
  'X:\\Base\\Projects\\Project1': 'p1',
  'X:\\Base\\Projects\\Project2': 'p2',
  'X:\\Base\\Big': 'g1',
  'X:\\Base\\Big\\Child': 'g2',
}));
fs.writeFileSync(registryPath, JSON.stringify({ splits: ['p1', 'p2', 'g1', 'g2'], default: '' }));

// ---- harness ----------------------------------------------------------------
function baseEnv(extra = {}) {
  const env = {
    ...process.env,
    CLAUDE_SPLIT_GUARD_FOLDERS: foldersPath,
    CLAUDE_SPLIT_GUARD_REGISTRY: registryPath,
    CLAUDE_SPLIT_GUARD_SUBST_JSON: JSON.stringify({ 'd:': 'x:\\base' }),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SPLIT_GUARD_OFF;
  return Object.assign(env, extra);
}

function runGuard(input, env) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [GUARD], { input: payload, env, encoding: 'utf8' });
}

function decision(r) {
  if (!r.stdout.trim()) return 'allow';
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
  } catch { return 'allow'; }
}

function hookInput(tool, toolInput, cwd = 'X:\\Base\\Projects\\Project1') {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd };
}

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const P1 = { CLAUDE_CONFIG_DIR: CFG('p1') };

// ---- Task 1: pins + file tools ------------------------------------------------
check('read own pin', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project1\\notes.md' }), baseEnv(P1))), 'allow');
check('read foreign pin', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project2\\.env' }), baseEnv(P1))), 'deny');
check('edit foreign pin', decision(runGuard(hookInput('Edit', { file_path: 'X:\\Base\\Projects\\Project2\\a.ts' }), baseEnv(P1))), 'deny');
check('write foreign pin', decision(runGuard(hookInput('Write', { file_path: 'X:\\Base\\Projects\\Project2\\b.ts' }), baseEnv(P1))), 'deny');
check('notebookedit foreign pin', decision(runGuard(hookInput('NotebookEdit', { notebook_path: 'X:\\Base\\Projects\\Project2\\n.ipynb' }), baseEnv(P1))), 'deny');
check('glob explicit foreign path', decision(runGuard(hookInput('Glob', { pattern: '**/*.ts', path: 'X:\\Base\\Projects\\Project2' }), baseEnv(P1))), 'deny');
check('glob defaults to cwd', decision(runGuard(hookInput('Glob', { pattern: '*' }, 'X:\\Base\\Projects\\Project2'), baseEnv(P1))), 'deny');
check('grep foreign path', decision(runGuard(hookInput('Grep', { pattern: 'x', path: 'X:\\Base\\Projects\\Project2\\src' }), baseEnv(P1))), 'deny');
check('pin dir itself', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project2' }), baseEnv(P1))), 'deny');
check('relative resolves against cwd', decision(runGuard(hookInput('Read', { file_path: 'secret.txt' }, 'X:\\Base\\Projects\\Project2'), baseEnv(P1))), 'deny');
check('forward slashes match', decision(runGuard(hookInput('Read', { file_path: 'X:/Base/Projects/Project2/x.txt' }), baseEnv(P1))), 'deny');
check('unowned path', decision(runGuard(hookInput('Read', { file_path: 'C:\\temp\\scratch.txt' }), baseEnv(P1))), 'allow');

// nested pins: Big -> g1, Big\Child -> g2 (longest prefix wins, like launch routing)
const G1 = { CLAUDE_CONFIG_DIR: CFG('g1') };
const G2 = { CLAUDE_CONFIG_DIR: CFG('g2') };
check('parent split denied in child pin', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Big\\Child\\f.txt' }), baseEnv(G1))), 'deny');
check('child split allowed in child pin', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Big\\Child\\f.txt' }), baseEnv(G2))), 'allow');
check('child split denied outside child pin', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Big\\other\\f.txt' }), baseEnv(G2))), 'deny');
check('parent split allowed outside child pin', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Big\\other\\f.txt' }), baseEnv(G1))), 'allow');

// subst alias: d: -> x:\base, so D:\Projects\Project2 IS X:\Base\Projects\Project2
check('subst alias denied', decision(runGuard(hookInput('Read', { file_path: 'D:\\Projects\\Project2\\x.txt' }), baseEnv(P1))), 'deny');
check('subst alias own territory allowed', decision(runGuard(hookInput('Read', { file_path: 'D:\\Projects\\Project1\\x.txt' }), baseEnv(P1))), 'allow');

// home identity (no CLAUDE_CONFIG_DIR): denied every pin, allowed elsewhere
check('home denied pinned folder', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project1\\x.txt' }), baseEnv())), 'deny');
check('home allowed unpinned folder', decision(runGuard(hookInput('Read', { file_path: 'C:\\temp\\x.txt' }), baseEnv())), 'allow');

// deny reason names both sides
{
  const r = runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project2\\.env' }), baseEnv(P1));
  const reason = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { return ''; } })();
  check('reason hides owner', /'p2'/.test(reason), false);
  check('reason names session', /'p1'/.test(reason), true);
}

// kill switch + fail-open
check('kill switch allows foreign', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project2\\.env' }), baseEnv({ ...P1, CLAUDE_SPLIT_GUARD_OFF: '1' }))), 'allow');
{
  const r = runGuard('this is not json', baseEnv(P1));
  check('malformed stdin exits 1', r.status, 1);
  check('malformed stdin does not deny', decision(r), 'allow');
  check('malformed stdin warns on stderr', r.stderr.includes('split-guard'), true);
}
check('missing folders.json fails open', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project2\\.env' }), baseEnv({ ...P1, CLAUDE_SPLIT_GUARD_FOLDERS: path.join(tmp, 'nope.json') }))), 'allow');

// ---- Task 2: config-dir fencing ---------------------------------------------
check('foreign split config dir denied', decision(runGuard(hookInput('Read', { file_path: path.join(CFG('p2'), 'memory', 'x.md') }), baseEnv(P1))), 'deny');
check('own split config dir allowed', decision(runGuard(hookInput('Edit', { file_path: path.join(CFG('p1'), 'settings.json') }), baseEnv(P1))), 'allow');
check('splits root shared file allowed', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.claude-splits', 'claude-split.ps1') }), baseEnv(P1))), 'allow');
check('splits root non-split subdir allowed', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.claude-splits', 'docs', 'specs', 'x.md') }), baseEnv(P1))), 'allow');
check('carve-out statusline allowed', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude', 'statusline.js') }), baseEnv(P1))), 'allow');
check('carve-out ide contents allowed', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.claude', 'ide', 'lock.json') }), baseEnv(P1))), 'allow');
check('carve-out CLAUDE.md allowed', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.claude', 'CLAUDE.md') }), baseEnv(P1))), 'allow');
check('home claude settings denied for split', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude', 'settings.json') }), baseEnv(P1))), 'deny');
check('home claude transcripts denied for split', decision(runGuard(hookInput('Grep', { pattern: 'x', path: path.join(HOMEDIR, '.claude', 'projects') }), baseEnv(P1))), 'deny');
check('home allowed in own claude dir', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude', 'settings.json') }), baseEnv())), 'allow');
check('home denied split config dir', decision(runGuard(hookInput('Read', { file_path: path.join(CFG('p2'), '.credentials.json') }), baseEnv())), 'deny');
check('unknown config dir acts as home', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude', 'settings.json') }), baseEnv({ CLAUDE_CONFIG_DIR: 'C:\\temp\\weird' }))), 'allow');
check('unknown config dir denied pins', decision(runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project1\\x.txt' }), baseEnv({ CLAUDE_CONFIG_DIR: 'C:\\temp\\weird' }))), 'deny');

// ---- Task 3: bash command scanning --------------------------------------------
check('bash windows abs path denied', decision(runGuard(hookInput('Bash', { command: 'cat X:\\Base\\Projects\\Project2\\.env' }), baseEnv(P1))), 'deny');
check('bash forward-slash drive path denied', decision(runGuard(hookInput('Bash', { command: 'cat X:/Base/Projects/Project2/.env' }), baseEnv(P1))), 'deny');
check('bash git-bash posix path denied', decision(runGuard(hookInput('Bash', { command: 'cat /x/base/projects/project2/.env' }), baseEnv(P1))), 'deny');
check('bash quoted path with spaces denied', decision(runGuard(hookInput('Bash', { command: 'cat "X:\\Base\\Projects\\Project2\\a b.txt"' }), baseEnv(P1))), 'deny');
check('bash single-quoted path denied', decision(runGuard(hookInput('Bash', { command: "cat 'X:\\Base\\Projects\\Project2\\c.txt'" }), baseEnv(P1))), 'deny');
check('bash tilde path denied', decision(runGuard(hookInput('Bash', { command: 'ls ~/.claude-splits/p2' }), baseEnv(P1))), 'deny');
check('bash subst spelling denied', decision(runGuard(hookInput('Bash', { command: 'cat D:\\Projects\\Project2\\x.txt' }), baseEnv(P1))), 'deny');
check('bash own territory allowed', decision(runGuard(hookInput('Bash', { command: 'cat X:\\Base\\Projects\\Project1\\notes.md' }), baseEnv(P1))), 'allow');
check('bash relative escape not caught', decision(runGuard(hookInput('Bash', { command: 'cd ..; cat Project2/secret.txt' }), baseEnv(P1))), 'allow');
check('bash no paths allowed', decision(runGuard(hookInput('Bash', { command: 'git status' }), baseEnv(P1))), 'allow');
check('bash redirect into foreign pin denied', decision(runGuard(hookInput('Bash', { command: 'echo pwned > X:\\Base\\Projects\\Project2\\owned.txt' }), baseEnv(P1))), 'deny');

// ---- Task 4 fix: PowerShell tool routed like Bash ------------------------------
check('powershell abs path denied', decision(runGuard(hookInput('PowerShell', { command: 'Get-Content X:\\Base\\Projects\\Project2\\.env' }), baseEnv(P1))), 'deny');
check('powershell no paths allowed', decision(runGuard(hookInput('PowerShell', { command: 'Get-Date' }), baseEnv(P1))), 'allow');

// ---- final-review fixes ---------------------------------------------------------
// Fix 1: registry unreadable = loud fail-open (exit 1), never a silent wrong identity
{
  const r = runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project1\\x.txt' }), baseEnv({ ...P1, CLAUDE_SPLIT_GUARD_REGISTRY: path.join(tmp, 'no-registry.json') }));
  check('missing registry exits 1', r.status, 1);
  check('missing registry does not deny', decision(r), 'allow');
  check('missing registry warns on stderr', r.stderr.includes('split-guard'), true);
}
{
  const badReg = path.join(tmp, 'bad-registry.json');
  fs.writeFileSync(badReg, '{not json');
  const r = runGuard(hookInput('Read', { file_path: 'X:\\Base\\Projects\\Project1\\x.txt' }), baseEnv({ ...P1, CLAUDE_SPLIT_GUARD_REGISTRY: badReg }));
  check('corrupt registry exits 1', r.status, 1);
  check('corrupt registry does not deny', decision(r), 'allow');
}
// Fix 2: home's ~/.claude.json state file is home territory
check('home state file denied for split', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude.json') }), baseEnv(P1))), 'deny');
check('home state backup denied for split', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.claude.json.backup') }), baseEnv(P1))), 'deny');
check('home state file allowed for home', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude.json') }), baseEnv())), 'allow');
// Fix 3: \\?\ spelling is canonicalized before matching
check('extended-length path denied', decision(runGuard(hookInput('Read', { file_path: '\\\\?\\X:\\Base\\Projects\\Project2\\x.txt' }), baseEnv(P1))), 'deny');

// ---- name hiding: the pin-map files are home-owned ------------------------------
check('folders map denied for split', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.config', 'claude-split', 'folders.json') }), baseEnv(P1))), 'deny');
check('registry denied for split', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.claude-splits', 'registry.json') }), baseEnv(P1))), 'deny');
check('folders map allowed for home', decision(runGuard(hookInput('Read', { file_path: path.join(HOMEDIR, '.config', 'claude-split', 'folders.json') }), baseEnv())), 'allow');
check('registry allowed for home', decision(runGuard(hookInput('Edit', { file_path: path.join(HOMEDIR, '.claude-splits', 'registry.json') }), baseEnv())), 'allow');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
