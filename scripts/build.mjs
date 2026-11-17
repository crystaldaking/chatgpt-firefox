import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { force: true, recursive: true });
await mkdir("dist/extension", { recursive: true });
await Promise.all([
  build({
    entryPoints: { background: "extension/src/background.ts", popup: "extension/src/popup.ts" },
    outdir: "dist/extension",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "firefox160",
  }),
  build({
    entryPoints: { "native-host": "native-host/src/index.ts", "mcp-server": "mcp-server/src/index.ts" },
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["@modelcontextprotocol/sdk/*"],
  }),
  ...["manifest.json", "popup.html", "popup.css"].map(file => copyFile("extension/" + file, "dist/extension/" + file)),
]);
