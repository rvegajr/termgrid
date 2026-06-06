# Changelog

## [0.1.7](https://github.com/rvegajr/termgrid/compare/v0.1.6...v0.1.7) (2026-06-06)


### Features

* intelligent folder deduplication for "Open in TermGrid" context menu ([c674cd5](https://github.com/rvegajr/termgrid/commit/c674cd59f54ba3f2ec8294ee4b7ca9f413f68665))

## [0.1.6](https://github.com/rvegajr/termgrid/compare/v0.1.5...v0.1.6) (2026-06-06)


### Features

* auto-restore last session on launch; new tabs show shell picker ([89743cb](https://github.com/rvegajr/termgrid/commit/89743cbac6835c671520f08a65506e18cfb4e71e))


### Bug Fixes

* never let an incomplete restore delete tabs/panes (reconcile on save) ([c65fef8](https://github.com/rvegajr/termgrid/commit/c65fef8fdb8eda80b414277b978a2ee529dec0d6))
* restore failed silently for sessions saved with the "default" shell sentinel ([7040f87](https://github.com/rvegajr/termgrid/commit/7040f87926ace2f335a6362d999472c738f4b316))
* window X not closing — remove flush-on-close interceptor ([e71c4fc](https://github.com/rvegajr/termgrid/commit/e71c4fc8bbb9fce17c1f2d9d42a74d6365cea3a0))


### Performance

* optimize terminal I/O hot path and fix PTY lifecycle leaks ([571cd3d](https://github.com/rvegajr/termgrid/commit/571cd3d96ba5d2ad50dc4ef50a2df3bb86f7aa56))


### Refactor

* remove drag-to-pane adoption monitor and platform stubs ([3afa04c](https://github.com/rvegajr/termgrid/commit/3afa04c54fd5a3041cb7015992f8791b078fef98))

## [0.1.5](https://github.com/rvegajr/termgrid/compare/v0.1.4...v0.1.5) (2026-05-15)


### Features

* drop-to-paste for text + files / folders; rename misnamed drag monitor ([fccc4cf](https://github.com/rvegajr/termgrid/commit/fccc4cf090b849942957f5716cbd15255a9af42d))


### Docs

* document v5 session adoption + per-pane host indicator ([1d3a814](https://github.com/rvegajr/termgrid/commit/1d3a81436df6ecbdbf8467b3ba5900003c9a381b))

## [0.1.4](https://github.com/rvegajr/termgrid/compare/v0.1.3...v0.1.4) (2026-05-14)


### Bug Fixes

* **release:** unwire macOS signing until cert is installed in CI ([19a6d7e](https://github.com/rvegajr/termgrid/commit/19a6d7ed02927321417e19e1da1865722f6c0b9c))

## [0.1.3](https://github.com/rvegajr/termgrid/compare/v0.1.2...v0.1.3) (2026-05-14)


### Features

* comprehensive feature implementation and performance optimization ([1604f55](https://github.com/rvegajr/termgrid/commit/1604f559ff669840aaa914b6c8542cee3c11ef1f))
* **v5:** adoption-memory import/export with file dialogs ([34f68af](https://github.com/rvegajr/termgrid/commit/34f68affceaf9feff921485ed7cfd8e732acf610))
* **v5:** functional drag-detection, native env capture, pane host indicator ([1a5a149](https://github.com/rvegajr/termgrid/commit/1a5a1492d6093e1bfae06a70bee7a2952432d3b7))
* **v5:** Linux X11 drag-to-pane adoption via XQueryPointer ([1c789de](https://github.com/rvegajr/termgrid/commit/1c789de2da5f988f98c8e31cee544b41f65444a9))
* **v5:** macOS drag-to-pane adoption with Accessibility API ([cc50fe8](https://github.com/rvegajr/termgrid/commit/cc50fe82e97496dbb9263ec153a32715e5d75278))
* **v5:** macOS native env capture via task_for_pid + debugger entitlement ([03621c7](https://github.com/rvegajr/termgrid/commit/03621c7d62b28d2697e4fc4d59c8c5259c0a6330))
* **v5:** shell-cooperative adoption plugin for zsh/bash/fish ([b04d655](https://github.com/rvegajr/termgrid/commit/b04d65547a45c4627981e89d025734bdf18228a2))
* **v5:** Windows drag-to-pane adoption via SetWinEventHook ([10d392e](https://github.com/rvegajr/termgrid/commit/10d392ef2f7339bfbf4230ecd154edb2f5995a18))


### Bug Fixes

* **build:** restore cross-platform dependencies to [dependencies] ([37d8ddd](https://github.com/rvegajr/termgrid/commit/37d8ddd006b2ab241f0a1589c101f09ad9c0be0f))
* **build:** silence dead_code for extract_macos_env_tokens on Linux ([445d641](https://github.com/rvegajr/termgrid/commit/445d6418fb689f8a1addd42cdc19233c8583c0a3))
* **windows:** correct windows-rs paths for SetWinEventHook ([75bfb13](https://github.com/rvegajr/termgrid/commit/75bfb13d2c93b11ff0a0aff3d97563cd21e44d10))
* **windows:** wrap HWINEVENTHOOK in a Send newtype for static storage ([a3c89df](https://github.com/rvegajr/termgrid/commit/a3c89dfbd3cf610c36d484e291a3e89d98647baa))


### Docs

* rewrite README to cover every shipped feature ([42bc77d](https://github.com/rvegajr/termgrid/commit/42bc77d7f3c11c1408f896ef204c32058b103d45))

## [0.1.2](https://github.com/rvegajr/termgrid/compare/v0.1.1...v0.1.2) (2026-05-06)


### Features

* workspace restore, deep-link OS integrations, larger grids ([acc7d66](https://github.com/rvegajr/termgrid/commit/acc7d66e047d40dd2cee619fa2d8037feec9176f))


### Docs

* warn against force-moving release tags; explain when it's tolerable ([94934a2](https://github.com/rvegajr/termgrid/commit/94934a236fdd470e88939c015ef04a341ac303de))

## [0.1.1](https://github.com/rvegajr/termgrid/compare/v0.1.0...v0.1.1) (2026-05-03)


### Bug Fixes

* **ci:** drop conflicting libappindicator3-dev and remove dead vars ([71e5e6a](https://github.com/rvegajr/termgrid/commit/71e5e6a76e170fc6603e53ed2d9515635705320e))
* **rust:** clippy --fix (Default impls, std::io::Error::other) ([bace100](https://github.com/rvegajr/termgrid/commit/bace100b0f19c711a0945a45c9be1dd79457b773))


### Docs

* rewrite README, polish RELEASING runbook, add preflight script ([b5091fe](https://github.com/rvegajr/termgrid/commit/b5091fe8eb62cdd3896c43823f42e679fa3c38a6))
