# Releasing TermGrid

The release pipeline is **automated end-to-end** once secrets are configured. You merge PRs; release-please proposes a version bump; you merge that; CI builds, signs, notarizes, and publishes.

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
                                            │   • update latest.json   │
                                            └──────────────────────────┘
                                                       │
                                                       ▼
                                            users auto-update on next launch
```

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
# Update plugins.updater.endpoints to your repo URL
```

**Keep the private key safe** — losing it means existing installs can never auto-update again.

## Cutting a release

1. Land your changes via PR with a Conventional Commit title.
2. release-please opens (or updates) a `chore(main): release vX.Y.Z` PR.
3. Review its proposed `CHANGELOG.md` and version bump.
4. Merge it. release-please tags `vX.Y.Z` and pushes.
5. The `Release` workflow fires, builds for all four platforms, signs, notarizes, and uploads a draft GitHub Release.
6. Inspect the draft. Edit notes if you want. Publish.
7. The `publish-updater-manifest` job updates `latest.json`. Existing installs see the update on next launch.

## Updater manifest format

`latest.json` published at the `endpoints` URL must look like:

```json
{
  "version": "0.2.0",
  "notes": "See full changelog at https://github.com/your-org/termgrid/releases/tag/v0.2.0",
  "pub_date": "2026-05-01T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of .sig file from build>",
      "url": "https://github.com/your-org/termgrid/releases/download/v0.2.0/TermGrid_0.2.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64": { "signature": "...", "url": "..." },
    "linux-x86_64":  { "signature": "...", "url": "..." },
    "windows-x86_64":{ "signature": "...", "url": "..." }
  }
}
```

Each `signature` is the contents of the `.sig` file `tauri-action` emits next to each artifact. The `publish-updater-manifest` workflow assembles this from the Release artifacts. Until you script that, you can publish manually using the `tauri-apps/tauri-action` outputs.

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
