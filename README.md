# Firefox Workspace for Codex

[![CI](https://github.com/crystaldaking/chatgpt-firefox/actions/workflows/ci.yml/badge.svg)](https://github.com/crystaldaking/chatgpt-firefox/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give Codex a dedicated group of background tabs in your existing Firefox profile. Codex can open pages, read them, follow links, and fill ordinary form fields while you work in other tabs.

This is an independent open-source project. It connects to local Codex through MCP.

## Requirements

- macOS and desktop Firefox 160 or newer
- Node.js 24 or newer
- A local Codex client with MCP support

## Install from source

```sh
git clone https://github.com/crystaldaking/chatgpt-firefox.git
cd chatgpt-firefox
npm ci
npm run build
npm run install:local
codex mcp add chatgpt-firefox -- "$(command -v node)" "$PWD/dist/mcp-server.mjs"
```

1. In Firefox, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and select `dist/extension/manifest.json` from the checkout.
2. Open **Firefox Workspace for Codex** from Firefox's extensions menu in the window you want to use and select **Connect Codex**.
3. Restart your local Codex client or reopen its MCP settings so it loads the new server. In a local chat, ask it to call `firefox_status`. The response should show `connected: true`.
4. Ask Codex to open a URL in its Firefox workspace. The first time it requests that site, open the Firefox extension, select **Allow** next to the origin and confirm the browser prompt. Then ask Codex to retry.

For example, ask “Open https://example.org in the Firefox workspace and tell me its heading.” The workspace appears in a group named **Codex** after its first tab opens.

Use **Share or return tab in Codex workspace** from a Firefox tab's context menu to give Codex access or take the tab back. Select **Stop access** in the extension to disconnect and leave the tabs open.

The temporary add-on needs to be loaded again after restarting Firefox. This version is distributed as source.

## Permissions and data

The extension uses tab metadata to verify group membership and reports only workspace tabs to Codex. Site access requires an explicit approval for each origin in the current workspace. You can revoke it in the popup. Ordinary Firefox cookies are applied by the browser in its existing profile.

The bridge uses a per-user Unix socket and Firefox Native Messaging. Page text, titles, URLs, and interaction results returned by MCP may become part of your Codex conversation. The project runs no hosted service and sends no project telemetry. See [data handling and security boundaries](docs/architecture.md#data-handling).

Page operations target the main document, and clicks use DOM events. Some sites require a manual click, sign-in, a system dialog, or other interactions outside this interface.

## Remove

Unload the temporary add-on in `about:debugging`, then run the following from the checkout.

```sh
codex mcp remove chatgpt-firefox
npm run uninstall:local
```

## Develop

```sh
npm ci
npm run check
```

On macOS with the native host installed, use `npm run test:firefox` to run the full MCP → Firefox browser test in an isolated profile. See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), and [agent instructions](AGENTS.md).
