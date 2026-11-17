import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

if (process.platform !== "darwin") {
  console.error("The local installer currently supports macOS.");
  process.exit(1);
}

const name = "io.github.crystaldaking.chatgpt_firefox";
const extensionId = "chatgpt-firefox@crystaldaking.github.io";
const manifestDirectory = join(homedir(), "Library/Application Support/Mozilla/NativeMessagingHosts");
const installDirectory = join(homedir(), "Library/Application Support/chatgpt-firefox");
const manifestPath = join(manifestDirectory, name + ".json");
const launchPath = join(installDirectory, "native-host");
const hostPath = fileURLToPath(new URL("../dist/native-host.mjs", import.meta.url));
const description = "Local Firefox workspace bridge for Codex";

async function readInstalledManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

async function writeAtomic(path, data, mode) {
  const temporary = path + "." + randomUUID();
  try {
    await writeFile(temporary, data, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function quoteShell(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

const existing = await readInstalledManifest();
if (existing && (existing.name !== name || existing.path !== launchPath || existing.description !== description)) {
  throw new Error("The target Firefox manifest is already managed by another installation.");
}

if (process.argv[2] === "--remove") {
  if (existing) {
    await rm(manifestPath);
    await rm(launchPath, { force: true });
  }
  console.log("Firefox native host removed.");
} else {
  await access(hostPath, constants.R_OK);
  await mkdir(manifestDirectory, { recursive: true });
  await mkdir(installDirectory, { recursive: true, mode: 0o700 });
  const launcher = "#!/bin/sh\nexec " + quoteShell(process.execPath) + " " + quoteShell(hostPath) + ' "$@"\n';
  const manifest = { name, description, path: launchPath, type: "stdio", allowed_extensions: [extensionId] };
  await writeAtomic(launchPath, launcher, 0o700);
  await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n", 0o600);
  console.log("Installed the Firefox native host for this user.");
}
