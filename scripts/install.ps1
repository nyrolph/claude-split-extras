# Deploys the claude-split extras onto THIS machine. Idempotent: every step
# reports done/skipped. Run from anywhere: pwsh -File scripts\install.ps1
# Reads local\local-config.json (the private sidecar) when present; without it,
# pins/exclusions/deny lists are skipped and printed as manual follow-ups.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$splitsRoot = Join-Path $env:USERPROFILE '.claude-splits'
$homeClaude = Join-Path $env:USERPROFILE '.claude'
$cfgDir = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'claude-split' } else { Join-Path $env:USERPROFILE '.config\claude-split' }
$sidecar = Join-Path $repo 'local\local-config.json'
$cfg = $null
if (Test-Path $sidecar) { $cfg = Get-Content $sidecar -Raw | ConvertFrom-Json }

# 0. Upstream reference (bcostea/claude-split) as a git submodule: present when
# the clone used --recurse-submodules; initialize it here otherwise. Purely a
# reference copy on Windows - nothing below depends on it.
if ((Test-Path (Join-Path $repo '.gitmodules')) -and -not (Test-Path (Join-Path $repo 'upstream\README.md'))) {
  try { git -C $repo submodule update --init 2>&1 | Out-Null; "init  upstream/ submodule" }
  catch { "skip  upstream/ submodule (git or network unavailable)" }
} else { "skip  upstream/ submodule (already present)" }

function Deploy([string]$src, [string]$dst) {
  New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
  if ((Test-Path $dst) -and (Get-FileHash $dst).Hash -eq (Get-FileHash $src).Hash) { "skip  $dst (identical)"; return }
  if (Test-Path $dst) { Copy-Item $dst "$dst.pre-extras.bak" -Force; "backup $dst -> .pre-extras.bak" }
  Copy-Item $src $dst -Force
  "deploy $dst"
}

# 1. Core files.
Deploy (Join-Path $repo 'wrapper\claude-split.ps1')    (Join-Path $splitsRoot 'claude-split.ps1')
Deploy (Join-Path $repo 'guard\split-guard.mjs')       (Join-Path $splitsRoot 'split-guard.mjs')
Deploy (Join-Path $repo 'guard\split-guard.test.mjs')  (Join-Path $splitsRoot 'split-guard.test.mjs')
Deploy (Join-Path $repo 'statusline\statusline.js')    (Join-Path $homeClaude 'statusline.js')

# 2. $PROFILE dot-source line.
$line = ". `"$(Join-Path $splitsRoot 'claude-split.ps1')`""
New-Item -ItemType Directory -Force (Split-Path $PROFILE) | Out-Null
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File $PROFILE | Out-Null }
if ((Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue) -notlike "*claude-split.ps1*") {
  Add-Content $PROFILE "`n# claude-split extras`n$line"
  "profile: dot-source line added to $PROFILE"
} else { "skip  profile line (already present)" }

# 3. Sidecar-driven config.
if ($cfg) {
  New-Item -ItemType Directory -Force $cfgDir | Out-Null
  if ($cfg.pins) {
    $cfg.pins | ConvertTo-Json | Set-Content (Join-Path $cfgDir 'folders.json') -Encoding utf8
    "config: folders.json written ($(@($cfg.pins.PSObject.Properties).Count) pins)"
  }
  if ($cfg.excludePlugins) {
    @{ excludePlugins = @($cfg.excludePlugins) } | ConvertTo-Json | Set-Content (Join-Path $cfgDir 'extras.json') -Encoding utf8
    "config: extras.json written (excludePlugins: $($cfg.excludePlugins -join ', '))"
  }
} else {
  "NOTE: no local\local-config.json sidecar - skipped pins/exclusions/deny lists."
  "      Recreate them per the README, or copy the sidecar from your other machine."
}

# 4. Per-profile settings: guard hook (+ deny list when the sidecar provides one).
$hookCmd = 'node ' + ($splitsRoot -replace '\\', '/') + '/split-guard.mjs'
$profiles = @(@{ name = 'home'; dir = $homeClaude })
if ($cfg -and $cfg.splits) { foreach ($s in $cfg.splits) { $profiles += @{ name = [string]$s; dir = Join-Path $splitsRoot $s } } }
foreach ($p in $profiles) {
  $sj = Join-Path $p.dir 'settings.json'
  if (-not (Test-Path $sj)) { "skip  $($p.name): no settings.json yet (create the split first: cs --split-new $($p.name))"; continue }
  $s = Get-Content $sj -Raw | ConvertFrom-Json -AsHashtable
  $changed = $false
  if (-not $s.ContainsKey('hooks')) {
    $s['hooks'] = @{ PreToolUse = @(@{ matcher = 'Read|Edit|Write|NotebookEdit|Glob|Grep|Bash|PowerShell'; hooks = @(@{ type = 'command'; command = $hookCmd }) }) }
    $changed = $true; "wire  $($p.name): PreToolUse guard hook"
  } else { "skip  $($p.name): hooks key already present (verify the guard is in it)" }
  $deny = if ($cfg -and $cfg.denyLists) { $cfg.denyLists.($p.name) } else { $null }
  if ($deny -and $deny.Count -and -not $s.ContainsKey('permissions')) {
    $s['permissions'] = @{ deny = @($deny) }
    $changed = $true; "wire  $($p.name): name-hiding deny list ($($deny.Count) entries)"
  } elseif ($deny -and $deny.Count) { "skip  $($p.name): permissions key already present (merge deny list by hand)" }
  if ($changed) { $s | ConvertTo-Json -Depth 10 | Set-Content $sj -Encoding utf8 }
}

# 5. Repo pre-commit hook (leak guard).
$hook = Join-Path $repo '.git\hooks\pre-commit'
if (Test-Path (Join-Path $repo '.git')) {
  Set-Content $hook "#!/bin/sh`npwsh -NoProfile -File `"`$(git rev-parse --show-toplevel)/scripts/check-clean.ps1`" || exit 1" -Encoding utf8 -NoNewline
  "hook  pre-commit installed"
}

""
"Done. Remaining manual steps (see README): create/sign in splits (cs --split-new <name>),"
"and re-run this script afterwards so their settings get the guard hook and deny lists."
