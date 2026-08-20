# claude-split for Windows — PowerShell equivalent of
# github.com/bcostea/claude-split, which cannot build or run here (it calls
# syscall.Exec, absent on Windows, and finds `claude` by looking for an
# extensionless file with a Unix executable bit, while ours is claude.exe).
#
# Same mechanism as upstream: point CLAUDE_CONFIG_DIR at ~/.claude-splits/<name>
# and run the real claude. Same on-disk layout too — registry.json and
# folders.json in the same places with the same shape — so if upstream ever
# ships Windows support, this data is already in the right form.
#
# Two deliberate differences:
#   * No minted CLAUDE_CODE_OAUTH_TOKEN. Upstream needs one because macOS keeps
#     credentials in the Keychain, shared across config dirs; on Windows they
#     live in <config dir>\.credentials.json, so each split logs in on its own.
#   * Folder pins match by longest path prefix, not exact path. Pinning
#     D:\Clients\Acme therefore covers D:\Clients\Acme\webapp, which is
#     what "use that client's split when launching from D:\Clients\Acme" means.
#
# Dot-source from $PROFILE. Usage: cs [--split <name>] [claude args...]

$script:CsRoot = Join-Path $env:USERPROFILE '.claude-splits'
$script:CsFolders = if ($env:XDG_CONFIG_HOME) {
  Join-Path $env:XDG_CONFIG_HOME 'claude-split\folders.json'
} else {
  Join-Path $env:USERPROFILE '.config\claude-split\folders.json'
}

# Optional extras config beside folders.json, e.g. { "excludePlugins": ["x"] }:
# plugin/marketplace names never seeded into new splits (work-only plugins that
# must not leak into other profiles). Absent file means nothing is excluded.
$script:CsExtrasFile = Join-Path (Split-Path $script:CsFolders) 'extras.json'
$script:CsExcludePlugins = @()
if (Test-Path $script:CsExtrasFile) {
  try {
    $j = Get-Content $script:CsExtrasFile -Raw | ConvertFrom-Json
    if ($j.excludePlugins) {
      $script:CsExcludePlugins = @($j.excludePlugins | ForEach-Object { [string]$_ })
    }
  } catch { }
}

# `subst` drive mappings, e.g. "D:\: => C:\Data". Cached: subst.exe is cheap but
# CsNorm runs once per pin per launch. A subst added mid-shell needs a new shell.
function script:CsSubstMap {
  if ($null -ne $script:CsSubst) { return $script:CsSubst }
  $map = @{}
  try {
    foreach ($line in (& "$env:SystemRoot\System32\subst.exe" 2>$null)) {
      $m = [regex]::Match($line, '^([A-Za-z]):\\?:\s+=>\s+(.+)$')
      if ($m.Success) {
        $map[($m.Groups[1].Value + ':').ToLowerInvariant()] = $m.Groups[2].Value.TrimEnd('\')
      }
    }
  } catch { }
  $script:CsSubst = $map
  return $map
}

function script:CsNorm([string]$p) {
  if (-not $p) { return '' }
  try { $p = (Resolve-Path -LiteralPath $p -ErrorAction Stop).Path } catch { }
  $p = $p.TrimEnd('\')
  # Expand subst drives to their target. Resolve-Path does NOT canonicalize
  # these, so a subst alias D:\Data and its target C:\Store\Data are the same
  # physical directory under two absolute paths — and without this, a pin on each would
  # both match, making the profile you land in depend on which path you cd'd
  # through. Silent, and it splits one project's history across two profiles.
  if ($p.Length -ge 2 -and $p[1] -eq ':') {
    $sub = script:CsSubstMap
    $drive = $p.Substring(0, 2).ToLowerInvariant()
    if ($sub.ContainsKey($drive)) { $p = $sub[$drive] + $p.Substring(2) }
  }
  return $p.ToLowerInvariant()
}

function script:CsLoadRegistry {
  $f = Join-Path $script:CsRoot 'registry.json'
  if (Test-Path $f) {
    $r = Get-Content $f -Raw | ConvertFrom-Json
    # 'colors' is optional and hand-edited; carry it through load *and* save or
    # the next `cs new` / `cs default` would quietly drop it.
    $colors = [ordered]@{}
    if ($r.PSObject.Properties['colors']) {
      foreach ($p in $r.colors.PSObject.Properties) { $colors[$p.Name] = [string]$p.Value }
    }
    return [pscustomobject]@{ splits = @($r.splits); default = [string]$r.default; colors = $colors }
  }
  return [pscustomobject]@{ splits = @(); default = ''; colors = [ordered]@{} }
}

function script:CsSaveRegistry($reg) {
  New-Item -ItemType Directory -Force $script:CsRoot | Out-Null
  $out = [ordered]@{ splits = @($reg.splits); default = $reg.default }
  if ($reg.PSObject.Properties['colors'] -and $reg.colors.Count) { $out['colors'] = $reg.colors }
  $out | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $script:CsRoot 'registry.json') -Encoding utf8
}

function script:CsLoadFolders {
  $map = [ordered]@{}
  if (Test-Path $script:CsFolders) {
    $o = Get-Content $script:CsFolders -Raw | ConvertFrom-Json
    foreach ($p in $o.PSObject.Properties) { $map[$p.Name] = [string]$p.Value }
  }
  return $map
}

function script:CsSaveFolders($map) {
  New-Item -ItemType Directory -Force (Split-Path $script:CsFolders) | Out-Null
  $map | ConvertTo-Json -Depth 5 | Set-Content $script:CsFolders -Encoding utf8
}

# Longest matching prefix wins, so a deeper pin can override a broader one.
function script:CsPinFor([string]$cwd, $map) {
  $c = script:CsNorm $cwd
  $best = $null; $bestLen = -1; $bestKey = $null
  foreach ($k in $map.Keys) {
    $kn = script:CsNorm $k
    if ($c -eq $kn -or $c.StartsWith($kn + '\')) {
      if ($kn.Length -gt $bestLen) { $best = $map[$k]; $bestLen = $kn.Length; $bestKey = $k }
    }
  }
  if ($null -eq $best) { return $null }
  return [pscustomobject]@{ split = $best; pin = $bestKey }
}

# ---- per-split terminal background ----------------------------------------
# OSC 11 sets the terminal's *default* background, so it tints the whole window
# for as long as the session runs — Claude Code's TUI paints text over it and
# never repaints the background — and OSC 111 puts it back on exit.
#
# Two things it depends on, both verified 2026-08-17:
#   * The emulator must honour OSC 11. xterm.js (VS Code) and Windows Terminal
#     do; conhost does not, hence the guard in CsSetBg.
#   * In VS Code, terminal.integrated.gpuAcceleration must NOT be "off". The DOM
#     renderer updates xterm's colour state but paints the background from theme
#     CSS, so the tint is accepted and never drawn. This looked exactly like the
#     sequence being unsupported.
#
# Colours are dark tints chosen to keep contrast with a dark theme. Index is the
# split's position in registry.json, matching how statusline.js colours the split
# name. Override per split by hand-adding to registry.json:
#   "colors": { "myclient": "#14202e" }
$script:CsBgPalette = @('#14202e', '#16241a', '#2b2b2b', '#2a1f14', '#2b1a1f')

function script:CsBgFor([string]$split, $reg) {
  # The home profile is left alone: an untinted terminal is itself the signal.
  if (-not $split -or $split -eq 'default') { return $null }
  if ($reg.PSObject.Properties['colors'] -and $reg.colors[$split]) { return [string]$reg.colors[$split] }
  $i = [array]::IndexOf(@($reg.splits), $split)
  if ($i -lt 0) { $i = 0 }
  return $script:CsBgPalette[$i % $script:CsBgPalette.Count]
}

function script:CsSetBg([string]$hex) {
  # Conhost would print the sequence as literal text rather than ignore it.
  if (-not ($env:WT_SESSION -or $env:TERM_PROGRAM -eq 'vscode')) { return }
  # [Console]::Write, not Write-Host or the pipeline: the bytes have to reach the
  # console verbatim, and must never become this function's return value.
  if ($hex) { [Console]::Write("`e]11;$hex`a") } else { [Console]::Write("`e]111`a") }
}

function script:CsClaudeExe {
  $c = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
       Select-Object -First 1
  if (-not $c) { throw 'claude.exe not found on PATH' }
  return $c.Source
}

function script:CsSeedSplit([string]$name) {
  # A new split gets the things meant to exist in every profile — the shared
  # plugins and commands, the statusline, the user-scope CLAUDE.md rules, and an
  # ide junction — minus any excludePlugins from extras.json (work-only plugins).
  # Not $home: PowerShell's $HOME is ReadOnly+AllScope, so assigning to it is a
  # WriteError that leaves the variable pointing at the user profile root and
  # sends every path below one level too high.
  $homeDir = Join-Path $env:USERPROFILE '.claude'
  $dir     = Join-Path $script:CsRoot $name
  New-Item -ItemType Directory -Force $dir | Out-Null

  $xd = @(); if ($script:CsExcludePlugins.Count) { $xd = @('/XD') + $script:CsExcludePlugins }
  robocopy (Join-Path $homeDir 'plugins') (Join-Path $dir 'plugins') /E @xd /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed seeding plugins (exit $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
  Copy-Item (Join-Path $homeDir 'commands') (Join-Path $dir 'commands') -Recurse -Force -ErrorAction SilentlyContinue

  # Strip excluded marketplaces/plugins from the seeded manifests.
  $ip = Join-Path $dir 'plugins\installed_plugins.json'
  if (Test-Path $ip) {
    $j = Get-Content $ip -Raw | ConvertFrom-Json -AsHashtable
    foreach ($k in @($j['plugins'].Keys)) {
      foreach ($x in $script:CsExcludePlugins) {
        if ($k -match [regex]::Escape($x)) { $j['plugins'].Remove($k); break }
      }
    }
    $j | ConvertTo-Json -Depth 10 | Set-Content $ip -Encoding utf8
  }
  $km = Join-Path $dir 'plugins\known_marketplaces.json'
  if (Test-Path $km) {
    $j = Get-Content $km -Raw | ConvertFrom-Json -AsHashtable
    foreach ($k in @($j.Keys)) {
      foreach ($x in $script:CsExcludePlugins) {
        if ($k -match [regex]::Escape($x)) { $j.Remove($k); break }
      }
    }
    $j | ConvertTo-Json -Depth 10 | Set-Content $km -Encoding utf8
  }

  # Repoint installPath at this split's own cache. Seeding copies the plugin
  # trees in, but the manifest still records the home profile's paths, leaving
  # the split silently dependent on ~/.claude/plugins surviving — which it may
  # not, once the home profile is only a personal profile. The escaped form is
  # what's actually in the file; the plain replace catches any unescaped copy.
  if (Test-Path $ip) {
    $from = Join-Path $homeDir 'plugins\cache'
    $to   = Join-Path $dir  'plugins\cache'
    $raw = Get-Content $ip -Raw
    $raw = $raw.Replace($from.Replace('\', '\\'), $to.Replace('\', '\\'))
    $raw = $raw.Replace($from, $to)
    Set-Content $ip -Value $raw -Encoding utf8
  }

  # The VS Code extension advertises itself in ~/.claude/ide and has no
  # CLAUDE_CONFIG_DIR of its own, so without this junction the split's CLI reads
  # a directory VS Code never writes to and loses IDE attachment entirely.
  $ide = Join-Path $dir 'ide'
  if (-not (Test-Path $ide)) {
    New-Item -ItemType Directory -Force (Join-Path $homeDir 'ide') | Out-Null
    New-Item -ItemType Junction -Path $ide -Target (Join-Path $homeDir 'ide') | Out-Null
  }

  # User-scope rules are read from the profile's own config dir, so a split
  # without this copy silently drops every CLAUDE.md instruction.
  $md = Join-Path $homeDir 'CLAUDE.md'
  if ((Test-Path $md) -and -not (Test-Path (Join-Path $dir 'CLAUDE.md'))) {
    Copy-Item $md (Join-Path $dir 'CLAUDE.md') -Force
  }

  $s = Get-Content (Join-Path $homeDir 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
  $s['enabledPlugins'] = @{ 'superpowers@claude-plugins-official' = $true }
  if ($s.ContainsKey('extraKnownMarketplaces')) { $s.Remove('extraKnownMarketplaces') }
  $s | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $dir 'settings.json') -Encoding utf8
}

# Deliberately a plain function with no param block. Any [Parameter()] attribute
# (or [CmdletBinding()]) makes this an advanced function, and PowerShell then binds
# claude's own flags to its common parameters: `cs -p "prompt"` fails with
# "parameter name 'p' is ambiguous. Possible matches include: -ProgressAction,
# -PipelineVariable" and never reaches claude. $args keeps every token verbatim.
function Invoke-ClaudeSplit {
  $Arguments = @($args)

  $reg  = script:CsLoadRegistry
  $pass = [System.Collections.Generic.List[string]]::new()
  $split = $null; $splitSet = $false
  $cmd = $null; $cmdArg = $null

  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $a = $Arguments[$i]
    $name = $a; $inline = $null
    if ($a -like '--split*' -and $a.Contains('=')) {
      $name = $a.Substring(0, $a.IndexOf('=')); $inline = $a.Substring($a.IndexOf('=') + 1)
    }
    switch ($name) {
      '--split'         { if ($inline) { $split = $inline } else { $split = $Arguments[++$i] }; $splitSet = $true }
      '--split-new'     { $cmd = 'new';     $cmdArg = if ($inline) { $inline } else { $Arguments[++$i] } }
      '--split-default' { $cmd = 'default'; $cmdArg = if ($inline) { $inline } else { $Arguments[++$i] } }
      '--split-rm'      { $cmd = 'rm';      $cmdArg = if ($inline) { $inline } else { $Arguments[++$i] } }
      '--split-pin'     { $cmd = 'pin';     $cmdArg = if ($inline) { $inline } else { $Arguments[++$i] } }
      '--split-list'    { $cmd = 'list' }
      '--split-which'   { $cmd = 'which' }
      default           { $pass.Add($a) }
    }
  }

  $cwd = (Get-Location).Path
  $map = script:CsLoadFolders

  switch ($cmd) {
    'list' {
      $rows = @([pscustomobject]@{ SPLIT = 'default (home)'; DEFAULT = $(if ($reg.default -eq 'default') { '*' } else { '' }); 'LOGGED IN' = 'yes' })
      foreach ($s in $reg.splits) {
        $rows += [pscustomobject]@{
          SPLIT     = $s
          DEFAULT   = $(if ($reg.default -eq $s) { '*' } else { '' })
          'LOGGED IN' = $(if (Test-Path (Join-Path $script:CsRoot "$s\.credentials.json")) { 'yes' } else { 'no — signs in on first launch' })
        }
      }
      $rows | Format-Table -AutoSize
      if ($map.Count) {
        "Folder pins (longest prefix wins):"
        $map.GetEnumerator() | ForEach-Object { "  {0,-40} -> {1}" -f $_.Key, $_.Value }
      } else { "No folder pins." }
      return
    }
    'new' {
      if ($cmdArg -eq 'default') { Write-Error "'default' is reserved for the home profile"; return }
      if ($reg.splits -contains $cmdArg) { Write-Error "split '$cmdArg' already exists"; return }
      script:CsSeedSplit $cmdArg
      $reg.splits = @($reg.splits + $cmdArg)
      script:CsSaveRegistry $reg
      "Created split '$cmdArg' (seeded from the home profile, minus excluded plugins)."
      "It signs in on first launch: cs --split $cmdArg"
      "Name-hiding is hand-maintained: add the existing protected folders to this"
      "split's permissions.deny in its settings.json, and this split's own"
      "folder to every other profile's list - see the extras README (Name hiding)."
      return
    }
    'default' {
      if ($cmdArg -ne 'default' -and -not ($reg.splits -contains $cmdArg)) { Write-Error "unknown split '$cmdArg'"; return }
      $reg.default = $cmdArg; script:CsSaveRegistry $reg
      "Global default split set to '$cmdArg'."
      return
    }
    'rm' {
      if (-not ($reg.splits -contains $cmdArg)) { Write-Error "unknown split '$cmdArg'"; return }
      $ans = Read-Host "Remove split '$cmdArg' from the registry? Its directory and sessions are LEFT ON DISK. [y/N]"
      if ($ans -notmatch '^(y|yes)$') { 'Aborted.'; return }
      $reg.splits = @($reg.splits | Where-Object { $_ -ne $cmdArg })
      if ($reg.default -eq $cmdArg) { $reg.default = '' }
      script:CsSaveRegistry $reg
      foreach ($k in @($map.Keys)) { if ($map[$k] -eq $cmdArg) { $map.Remove($k) } }
      script:CsSaveFolders $map
      "Removed '$cmdArg' from the registry. Directory kept at $(Join-Path $script:CsRoot $cmdArg)."
      return
    }
    'pin' {
      if ($cmdArg -ne 'default' -and -not ($reg.splits -contains $cmdArg)) { Write-Error "unknown split '$cmdArg'"; return }
      $map[$cwd] = $cmdArg
      script:CsSaveFolders $map
      "Pinned $cwd (and everything under it) -> $cmdArg"
      return
    }
  }

  # ---- resolve: explicit --split > folder pin > global default > ask --------
  $reason = ''
  if ($splitSet) { $reason = 'explicit --split' }
  else {
    $hit = script:CsPinFor $cwd $map
    if ($hit) { $split = $hit.split; $splitSet = $true; $reason = "folder pin $($hit.pin)" }
    elseif ($reg.default) { $split = $reg.default; $splitSet = $true; $reason = 'global default' }
  }

  if (-not $splitSet) {
    if ($cmd -eq 'which') { "(none — would prompt to choose)"; return }
    $choices = @('default') + $reg.splits
    "No split pinned for $cwd. Choose one:"
    for ($i = 0; $i -lt $choices.Count; $i++) {
      $label = if ($choices[$i] -eq 'default') { 'default (home profile)' } else { $choices[$i] }
      "  [{0}] {1}" -f ($i + 1), $label
    }
    $sel = Read-Host "Number (or Enter to cancel)"
    if (-not $sel) { 'Cancelled.'; return }
    $idx = 0
    if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 1 -or $idx -gt $choices.Count) { Write-Error 'Invalid choice'; return }
    $split = $choices[$idx - 1]; $splitSet = $true; $reason = 'chosen interactively'
  }

  # ---- home-directory guard ------------------------------------------------
  # In $HOME, <cwd>\.claude *is* the home profile's config dir, and Claude Code
  # loads it as project scope regardless of CLAUDE_CONFIG_DIR — so a split there
  # is not actually isolated.
  if ($split -ne 'default' -and (script:CsNorm $cwd) -eq (script:CsNorm $env:USERPROFILE) -and -not $env:CLAUDE_SPLIT_ALLOW_HOME) {
    Write-Error "refusing to launch split '$split' from your home directory: ~/.claude would load as project config and defeat isolation. cd into a project, or set CLAUDE_SPLIT_ALLOW_HOME=1."
    return
  }

  if ($cmd -eq 'which') {
    if ($split -eq 'default') { "default (home profile)   [$reason]" } else { "$split   [$reason]" }
    return
  }

  # ---- foreign-territory guard ----------------------------------------------
  # split-guard denies every file operation in territory pinned to another
  # split, so a session launched there could not even read its own cwd. Refuse
  # now, before the auto-pin below records a foreign pin. 'default' (home) is
  # refused too: home is denied all pinned territory by the same hook.
  $owner = script:CsPinFor $cwd $map
  if ($owner -and $owner.split -ne $split -and -not $env:CLAUDE_SPLIT_ALLOW_FOREIGN) {
    Write-Error ("refusing to launch '{0}' in {1}, which is pinned to '{2}': split-guard would deny every file operation here. Use 'cs --split {2}', or set CLAUDE_SPLIT_ALLOW_FOREIGN=1 to override." -f $split, $cwd, $owner.split)
    return
  }

  $configDir = $null
  if ($split -ne 'default') {
    if (-not ($reg.splits -contains $split)) { Write-Error "unknown split '$split'"; return }
    $configDir = Join-Path $script:CsRoot $split
    if (-not (Test-Path $configDir)) { Write-Error "split directory missing: $configDir"; return }
  }

  # Remember an explicit choice for this folder, unless a pin already resolves
  # it to the same split (prefix matching makes a redundant child pin useless).
  if ($reason -in @('explicit --split', 'chosen interactively') -and
      (script:CsNorm $cwd) -ne (script:CsNorm $env:USERPROFILE)) {
    $existing = script:CsPinFor $cwd $map
    if (-not $existing -or $existing.split -ne $split) {
      $map[$cwd] = $split
      script:CsSaveFolders $map
      Write-Host "claude-split: pinned $cwd -> $split" -ForegroundColor DarkGray
    }
  }

  $exe = script:CsClaudeExe
  $bg  = script:CsBgFor $split $reg
  $had = Test-Path Env:\CLAUDE_CONFIG_DIR
  $old = $env:CLAUDE_CONFIG_DIR
  try {
    if ($configDir) { $env:CLAUDE_CONFIG_DIR = $configDir }
    elseif ($had)   { Remove-Item Env:\CLAUDE_CONFIG_DIR }
    if ($bg) { script:CsSetBg $bg }
    & $exe @pass
  } finally {
    if ($bg) { script:CsSetBg $null }
    if ($had) { $env:CLAUDE_CONFIG_DIR = $old }
    elseif (Test-Path Env:\CLAUDE_CONFIG_DIR) { Remove-Item Env:\CLAUDE_CONFIG_DIR }
  }
}

Set-Alias cs Invoke-ClaudeSplit
Set-Alias claude-split Invoke-ClaudeSplit
