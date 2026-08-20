# Syncs the four core files between this machine and the repo.
#   default        : collect (live -> repo), then run check-clean on the result.
#   -Deploy        : repo -> live (overwrites live copies; asks first).
# Collect may legitimately FAIL check-clean: live copies may carry private
# names in comments or test fixtures (machines that predate sanitization).
# Fix the repo copies by hand until check-clean passes, then commit.
param([switch]$Deploy)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$splitsRoot = Join-Path $env:USERPROFILE '.claude-splits'
$homeClaude = Join-Path $env:USERPROFILE '.claude'
$pairs = @(
  @{ live = Join-Path $splitsRoot 'claude-split.ps1';     repo = Join-Path $repo 'wrapper\claude-split.ps1' },
  @{ live = Join-Path $splitsRoot 'split-guard.mjs';      repo = Join-Path $repo 'guard\split-guard.mjs' },
  @{ live = Join-Path $splitsRoot 'split-guard.test.mjs'; repo = Join-Path $repo 'guard\split-guard.test.mjs' },
  @{ live = Join-Path $homeClaude 'statusline.js';        repo = Join-Path $repo 'statusline\statusline.js' }
)
if ($Deploy) {
  Write-Host "This OVERWRITES the live copies with the repo versions:"
  $pairs | ForEach-Object { Write-Host "  $($_.repo) -> $($_.live)" }
  $ans = Read-Host "Proceed? [y/N]"
  if ($ans -notmatch '^(y|yes)$') { 'Aborted.'; exit 0 }
  foreach ($p in $pairs) { Copy-Item $p.repo $p.live -Force; "deployed $($p.live)" }
  exit 0
}
foreach ($p in $pairs) {
  if ((Get-FileHash $p.live).Hash -eq (Get-FileHash $p.repo).Hash) { "same  $($p.repo)"; continue }
  Copy-Item $p.live $p.repo -Force
  "collected $($p.repo) (differs - review the diff before committing)"
}
""
& (Join-Path $PSScriptRoot 'check-clean.ps1')
if ($LASTEXITCODE -ne 0) {
  ""
  "Collect brought in forbidden strings (expected when live copies carry private"
  "names). Sanitize the repo copies by hand, re-run scripts\check-clean.ps1,"
  "then commit."
  exit 1
}
