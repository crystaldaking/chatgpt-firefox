# Working on chatgpt-firefox

Read [README.md](README.md) for setup and [docs/architecture.md](docs/architecture.md) for component boundaries and the tool contract.

## Start here

- Install locked dependencies with `npm ci`.
- Run `npm run check` for type checking, the build, and the native IPC and MCP smoke test.
- On macOS, build and run `npm run install:local` before `npm run test:firefox`. The test uses a temporary profile and a local HTTP fixture.

## Boundaries to preserve

- Enforce tab ownership and site permissions in the extension. A group name, a page instruction, or native client input cannot grant access.
- Target work tabs by their handles and keep operations in the background. Avoid calls that switch active tabs, use the global keyboard or mouse, or script personal tabs.
- Keep snapshots bounded and operations document-scoped. Preserve the distinction between a failed action and an action with an unknown outcome.
- Keep diagnostics free of page contents, credentials, and tool arguments. Use local fixtures in automated tests.
- Update the protocol, documentation, and tests together when changing the tool contract.

Only commit source, documentation, tests, and reproducible build configuration. Keep machine-specific paths, generated bundles, credentials, and local notes out of commits.
