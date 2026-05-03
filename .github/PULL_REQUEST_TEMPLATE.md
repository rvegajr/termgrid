<!-- Title format: Conventional Commits — feat:, fix:, chore:, docs:, refactor:, test:, build: -->

## What & why
<!-- One paragraph: what changed and why. Link issue if any. -->

## How
<!-- Touched files, key trade-offs, anything reviewers should look at first. -->

## Verification
- [ ] `pnpm test` passes
- [ ] `pnpm exec tsc --noEmit` clean
- [ ] `cargo test --lib` (in `src-tauri/`) passes
- [ ] Manually exercised the change in `pnpm tauri dev`
- [ ] No new permissions / network endpoints / secrets added (or called out below)

## Screenshots / recordings
<!-- For any UI change. -->

## Risk
<!-- Migration risk, perf risk, anything to watch in the release. -->
