# Contributing

Use Node.js 24 or newer, run `npm ci`, and read the [architecture guide](docs/architecture.md). A temporary Firefox profile is best for trying changes that affect group membership or native messaging.

Before opening a pull request, run `npm run check`. For changes that affect Firefox behavior, run `npm run test:firefox` on macOS after installing the native host and describe the browser version you tested. Include enough detail to reproduce behavior with a local fixture and update the user guide for changes to setup or tools.

For a bug report, include your OS, Firefox and Node versions, and the steps you took. Use a sample page or remove private URLs, page contents, and account data from attachments. Report vulnerabilities through the [security policy](SECURITY.md).
