# Scans all git-tracked and staged content (and file names) for forbidden
# strings listed in local/forbidden.txt - one case-insensitive regex per line,
# '#' comments allowed. The list is untracked on purpose: it names exactly what
# must never be pushed. Exit 1 on any hit or when the list is missing.
# Wired as the pre-commit hook; safe to run by hand any time.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$listFile = Join-Path $repo 'local\forbidden.txt'
if (-not (Test-Path $listFile)) {
  Write-Host "check-clean: $listFile is missing - refusing to pass an unscanned tree. Recreate it (see README, 'Leak guard')."
  exit 1
}
$patterns = @(Get-Content $listFile | Where-Object { $_ -and $_ -notmatch '^\s*#' })
$tracked = @(git -C $repo ls-files)
$staged  = @(git -C $repo diff --cached --name-only)
$all = @($tracked + $staged | Sort-Object -Unique | Where-Object { $_ })
$bad = 0
foreach ($f in $all) {
  foreach ($pat in $patterns) {
    if ([regex]::IsMatch($f, $pat, 'IgnoreCase')) { $bad++; Write-Host "LEAK (filename) $f : matches '$pat'" }
  }
  $p = Join-Path $repo $f
  if (-not (Test-Path $p)) { continue }
  $raw = Get-Content $p -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { continue }
  foreach ($pat in $patterns) {
    $ms = [regex]::Matches($raw, $pat, 'IgnoreCase')
    foreach ($m in $ms) { $bad++; Write-Host "LEAK $f : '$($m.Value)' matches '$pat'" }
  }
}
if ($bad) { Write-Host "check-clean: $bad forbidden match(es) - commit refused."; exit 1 }
Write-Host "check-clean: OK ($($all.Count) files, $($patterns.Count) patterns)"
exit 0
