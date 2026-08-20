# claude-split-extras

Private extensions on top of **[bcostea/claude-split](https://github.com/bcostea/claude-split/)** — the tool that gives Claude Code isolated per-context profiles ("splits") by pointing `CLAUDE_CONFIG_DIR` at per-split config dirs. Read the upstream README first; everything here assumes its concepts (splits, folder pins, the registry).

Upstream is a Go tool for macOS/Linux. These extras began as a Windows PowerShell port (offered upstream as an issue + PR) and grew several layers upstream does not have:

| Piece | What it adds |
|---|---|
| `wrapper/claude-split.ps1` | The full wrapper for Windows: `cs` command, folder pins with subst-drive canonicalization, split seeding (with plugin exclusions from `extras.json`), per-split terminal background tint (OSC 11), a home-directory launch guard, and a foreign-territory launch guard. Same on-disk layout as upstream (`registry.json`, `folders.json`). |
| `guard/split-guard.mjs` | A `PreToolUse` hook enforcing **territory isolation at the tool layer**: a session in one profile cannot read/write another profile's pinned folders or config dir. Longest-pin-prefix ownership, subst/git-bash/`~`/`\\?\` path canonicalization, Bash+PowerShell command scanning, fail-open-loudly error contract, `CLAUDE_SPLIT_GUARD_OFF=1` kill switch. |
| `guard/split-guard.test.mjs` | 66-check suite, no framework: `node split-guard.test.mjs`. |
| `statusline/statusline.js` | Status line that works from any profile (honours `CLAUDE_CONFIG_DIR`) and shows the profile name coloured by registry position, model, effort, tokens, context-to-autocompact, task progress, PR number. |
| `templates/` | The settings fragments every profile needs: the guard hook block, and the shape of a name-hiding deny list. |
| `scripts/` | `install.ps1` (deploy onto a machine), `sync.ps1` (live copies <-> repo), `check-clean.ps1` (leak guard, wired as pre-commit). |

## The privacy model of this repo

Nothing tracked here may contain a split name, a client/company name, or a personal folder path. All of that lives in **`local/`**, which is gitignored:

- `local/local-config.json` — the real splits, folder pins, plugin exclusions, and per-profile deny lists. `install.ps1` consumes it.
- `local/forbidden.txt` — regexes for everything that must never appear in tracked content. `check-clean.ps1` scans every tracked and staged file (content and name) against it and the pre-commit hook refuses leaking commits.

**You carry `local/` between machines yourself** (password manager, encrypted drive — anything you trust; never this repo). Without it, everything still installs; you just re-enter your pins and lists by hand following this README.

## Fresh machine install

Prerequisites: Windows 11, PowerShell 7, node, git, Claude Code (`claude.exe` on PATH).

1. Clone this repo anywhere (e.g. `~/claude-split-extras`). Installing upstream itself is not required on Windows — the wrapper replaces it while keeping its on-disk format.
2. Copy your `local/` sidecar into the clone (skip if starting from scratch).
3. `pwsh -File scripts\install.ps1` — deploys the wrapper, guard, tests and statusline; adds the `$PROFILE` dot-source line; writes `folders.json` + `extras.json` from the sidecar; wires the guard hook and deny lists into every profile whose `settings.json` already exists; installs the repo pre-commit hook.
4. Open a new shell. Create each split: `cs --split-new <name>`, then `cs --split <name>` from a folder of that split's territory and complete the interactive sign-in. Each profile signs in independently, by design — credentials never sync between machines or profiles.
5. Re-run `scripts\install.ps1` so the freshly created splits' `settings.json` get the guard hook and their deny lists.
6. Verify: `node ~\.claude-splits\split-guard.test.mjs` (expect `66 passed, 0 failed`); `cs --split-list`; from one split, ask Claude to read a file in another split's territory (expect a refusal citing `split-guard`).

## Adding a split / client

1. `cs --split-new <name>`; sign in on first launch.
2. Pin its folder: `cd <folder>; cs --split <name>` (auto-pins) or `cs --split-pin <name>`.
3. Name hiding (hand-maintained, by design): add the new folder as a `Read(//<drive>/<path>/**)` entry to every OTHER profile's `permissions.deny`, and give the new profile entries for all existing protected folders. Include a second entry for any subst-alias spelling. See `templates/settings-deny.example.json`. Rules hot-reload — no restarts.
4. Update `local/local-config.json` (splits, pins, denyLists) so the next machine install reproduces all of it, and add any new never-track names to `local/forbidden.txt`.

## Name hiding — what it does and does not do

Deny rules filter Glob/Grep traversal, so a foreign folder is absent from search results, and the guard blocks direct access with a reason that names no owner. Not covered (accepted residue): raw shell output (`ls` of a shared parent still prints names), subprocess file access, `$env:`-style variable paths in shell commands, and a profile reading its own settings (it can see its own deny list).

## Day-to-day sync

- Changed a live file (wrapper/guard/tests/statusline)? `pwsh -File scripts\sync.ps1` collects live -> repo and runs the leak scan. A machine whose live copies predate sanitization will fail the scan on collect — sanitize the repo copy by hand (generic example paths, generic fixture names), re-run `scripts\check-clean.ps1`, commit.
- `scripts\sync.ps1 -Deploy` pushes repo -> live (asks first). Note the repo wrapper reads plugin exclusions from `extras.json`; a live wrapper predating that parameterization hardcodes them instead — deploying replaces that behavior, so make sure `extras.json` exists first (`install.ps1` writes it from the sidecar).
- Never commit without the pre-commit hook active; `scripts\check-clean.ps1` must print `OK`.

## What never ports

Per-profile `.credentials.json` (each machine signs in fresh), the `ide` junctions (the wrapper recreates them), absolute paths inside settings hook commands (`install.ps1` templates them per machine), and any VS Code workspace `terminal.background` tints (per-workspace, per-machine).

## Upstream delta

- Offered upstream: the Windows port concept (issue + PR on [bcostea/claude-split](https://github.com/bcostea/claude-split/)). If upstream merges Windows support, revisit the wrapper: keep the on-disk format aligned (`registry.json`, `folders.json`) so switching or contributing back stays cheap.
- Local-only (not offered upstream): the isolation guard, name hiding, terminal tinting, launch guards, statusline, seeding exclusions.
