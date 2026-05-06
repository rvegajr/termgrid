# Releasing TermGrid

The release pipeline is **automated end-to-end** once secrets are configured. You merge PRs; release-please proposes a version bump; you merge that; CI builds, signs, notarizes, and publishes.

> **TL;DR for the impatient maintainer**
>
> 1. Land work as PRs whose **titles follow Conventional Commits** (`feat: …`, `fix: …`).
> 2. release-please opens a `chore(main): release vX.Y.Z` PR — review, then merge it.
> 3. Wait ~20 min for the matrix build to finish; **publish** the draft Release on GitHub.
> 4. Done. Existing installs auto-update on next launch (once the updater is enabled).

---

## The four release rules

These are the **only** rules you need to remember. Everything else is automated.

### Rule 1 — Every commit on `main` MUST be a Conventional Commit

| Prefix | Meaning | Bumps |
|---|---|---|
| `feat:` | new user-visible capability | **minor** |
| `fix:` | bug fix | **patch** |
| `perf:` | perf improvement | patch |
| `refactor:` | internal restructure, no behavior change | patch |
| `docs:` | docs only | none |
| `test:` | tests only | none |
| `chore:` / `build:` / `ci:` / `style:` | tooling / infra / formatting | none |
| `feat!:` or any with `BREAKING CHANGE:` footer | breaking change | **major** |

**Why:** `release-please` reads commit titles to decide the next version and write the changelog. Wrong prefix → wrong version → broken changelog. Squash-merge enforced on `main`, so the **PR title** is what gets recorded — title it correctly.

### Rule 2 — Run `pnpm preflight` before pushing

```bash
pnpm preflight   # mirrors CI: typecheck + vitest + cargo fmt/clippy/test
```

This runs the exact gates CI runs. Catching them locally saves a 5-minute round-trip.

### Rule 3 — Never push directly to `main`

Branch protection blocks force-pushes and requires the 5 status checks. Even as repo owner, open a PR. Squash-merge.

### Rule 4 — Don't manually edit `package.json` / `Cargo.toml` / `tauri.conf.json` versions

release-please owns the version field in all three. If you bump them by hand, release-please will conflict on the next run. The version bump happens **only** through the `chore(main): release …` PR.

---

## Pipeline overview

```
   merge feat/fix/perf PR              tag pushed (auto by release-please)
            │                                       │
            ▼                                       ▼
   release-please opens / updates           ┌──────────────────────────┐
   "chore(main): release X.Y.Z" PR          │ release.yml workflow     │
            │                               │  matrix:                 │
            ▼                               │   • macOS arm64 + x64    │
        merge that PR ─────────────────►    │   • Linux x86_64         │
                                            │   • Windows x86_64       │
                                            │  per platform:           │
                                            │   • build (tauri-action) │
                                            │   • sign + notarize      │
                                            │   • upload to Release    │
                                            └──────────────────────────┘
                                                       │
                                                       ▼
                                            you publish the draft Release
                                                       │
                                                       ▼
                                            users auto-update on next launch
```

---

## Per-release runbook

When you're ready to cut **vX.Y.Z**, go through this in order. Each line is one action.

### Pre-flight

- [ ] Local `main` is clean: `git status` shows nothing.
- [ ] Local `main` is current: `git pull`.
- [ ] CI on the latest `main` commit is green: `gh run list --workflow=ci.yml --limit 1`.
- [ ] `pnpm preflight` passes locally.
- [ ] Smoke-launch the app: `pnpm tauri dev` → open a pane, type a command, close, relaunch, confirm scrollback restores.

### Cut

- [ ] Open the release-please PR: `gh pr list --label "autorelease: pending"`.
- [ ] Read the proposed `CHANGELOG.md` diff. Anything missing or mis-categorized? Fix the original commit messages on `main`, push, wait for release-please to refresh.
- [ ] Merge the release-please PR (squash, default message).
- [ ] release-please pushes tag `vX.Y.Z`.
- [ ] `release.yml` workflow fires. Watch: `gh run watch --workflow=release.yml`.

### Publish

- [ ] After ~20 min, the matrix build finishes. A **draft Release** appears at https://github.com/rvegajr/termgrid/releases.
- [ ] Inspect the artifacts (4 platforms × 1–3 bundles each).
- [ ] Optional: edit the release notes (release-please copies the changelog).
- [ ] Click **Publish release**.
- [ ] If the updater is enabled, the `publish-updater-manifest` job updates `latest.json` so existing installs see the new version.

### Verify

- [ ] Download the artifact for your OS, install over the existing version, confirm the app still launches and your saved workspace restores.
- [ ] If the updater is enabled, launch an older copy of the app on another machine — the update prompt should appear.

### If something goes wrong

| Symptom | Action |
|---|---|
| release-please didn't open a PR | Check that recent commits use `feat:` / `fix:` / etc. Only those types trigger a release. |
| CI red on the release-please PR | Fix on `main` first. release-please will rebase its PR. |
| Build matrix red on a single platform | Inspect logs: `gh run view <run-id> --log-failed`. Re-run that job: `gh run rerun --failed <run-id>`. |
| Bad release shipped | See **Rollback** below. |

---

## One-time setup

### 1. Apple Developer (~$99/yr)

1. Enroll at https://developer.apple.com.
2. Create a **Developer ID Application** certificate. Export as `.p12` with a password.
3. Generate an **app-specific password** at https://appleid.apple.com → Sign-In and Security.
4. Find your **Team ID** at https://developer.apple.com/account → Membership.
5. Add to GitHub Secrets:

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | base64 of the `.p12` (e.g. `base64 -i cert.p12 \| pbcopy`) |
   | `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting |
   | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_PASSWORD` | the app-specific password (not your Apple ID password) |
   | `APPLE_TEAM_ID` | the 10-char Team ID |

### 2. Windows Authenticode (optional, ~$300/yr — defer if you can)

Without it, SmartScreen warns "unrecognized publisher" for ~weeks until reputation builds. Get an EV code-signing cert from DigiCert / Sectigo / SSL.com. Add:

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | base64 of the `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the password |

### 3. Tauri updater signing key (required to enable auto-update)

```bash
pnpm tauri signer generate -w ~/.tauri/termgrid.key
# Save private key (file contents) → GitHub Secret TAURI_SIGNING_PRIVATE_KEY
# Save the password (if you set one)  → TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# Paste the public key into src-tauri/tauri.conf.json → plugins.updater.pubkey
# Flip plugins.updater.active to true
# Flip bundle.createUpdaterArtifacts to true (currently false — see below)
# Update plugins.updater.endpoints to your repo URL
```

**Why `createUpdaterArtifacts` defaults to `false`:** when `true`, every release build attempts to sign the bundles with `TAURI_SIGNING_PRIVATE_KEY`. If the secret is unset, the entire build fails after producing the `.dmg` / `.deb` / `.msi`. We keep it `false` until you actually have the key. Once enabled, the build emits `*.sig` files alongside each artifact that the updater verifies.

**Keep the private key safe** — losing it means existing installs can never auto-update again.

---

## Updater manifest format

`latest.json` published at the `endpoints` URL must look like:

```json
{
  "version": "0.2.0",
  "notes": "See full changelog at https://github.com/rvegajr/termgrid/releases/tag/v0.2.0",
  "pub_date": "2026-05-01T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of .sig file from build>",
      "url": "https://github.com/rvegajr/termgrid/releases/download/v0.2.0/TermGrid_0.2.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64": { "signature": "...", "url": "..." },
    "linux-x86_64":  { "signature": "...", "url": "..." },
    "windows-x86_64":{ "signature": "...", "url": "..." }
  }
}
```

Each `signature` is the contents of the `.sig` file `tauri-action` emits next to each artifact. The `publish-updater-manifest` job assembles this from the Release artifacts.

---

## Hot-fix flow

1. Branch from the release tag: `git checkout -b hotfix/v0.2.1 v0.2.0`
2. Cherry-pick or commit the fix with `fix:` prefix.
3. PR back to `main`. release-please will bump the patch.
4. If the fix can't wait for `main` to be green, open the GitHub Release UI and tag manually — the `release.yml` workflow accepts any `v*` tag.

## Rollback

A bad release ships?

1. Mark the GitHub Release as a **pre-release** (hides it from "latest").
2. Update `latest.json` to point back at the previous version.
3. Auto-update will pull the previous version on next check (Tauri does support downgrade installs).
4. Tag a `v0.2.X+1` with the actual fix and let it ship normally.

## Distribution channels (post-launch)

- **GitHub Releases** — automatic, no extra work.
- **Homebrew Cask** — submit a manifest to homebrew/homebrew-cask, or self-host a tap.
- **winget** — submit to microsoft/winget-pkgs after the first signed Windows release.
- **Linux**: AppImage works out of the box; `.deb` and `.rpm` are produced by `tauri-action`. For Snap/Flatpak, separate manifests required.
