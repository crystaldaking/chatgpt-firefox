import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const extensionId = "chatgpt-firefox@crystaldaking.github.io";

function encode(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

test("Local MCP tools report disconnection and round-trip through the native host", { timeout: 15_000 }, async () => {
  const runtime = await mkdtemp("/tmp/cgf-mcp-");
  const env = { ...process.env, CHATGPT_FIREFOX_RUNTIME_DIR: runtime };
  const client = new Client({ name: "bridge-test", version: "1.0.0" });
  let host;
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["dist/mcp-server.mjs"], env, stderr: "inherit",
    }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
    assert.equal(tools.find(tool => tool.name === "firefox_snapshot")?.annotations.readOnlyHint, true);
    const status = () => client.callTool({ name: "firefox_status", arguments: {} });
    assert.equal((await status()).structuredContent.connected, false);

    host = spawn(process.execPath, ["dist/native-host.mjs", "manifest.json", extensionId], {
      env, stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = Buffer.alloc(0);
    let forwarded = 0;
    host.stdout.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE();
      if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      assert.equal(request.method, "firefox_status");
      assert.equal(request.version, 1);
      forwarded++;
      const reply = encode({ id: request.id, ok: true, result: { connected: true, grouped: false } });
      host.stdin.write(reply.subarray(0, 2));
      host.stdin.write(reply.subarray(2));
    });
    let reply;
    for (let attempt = 0; attempt < 30; attempt++) {
      reply = await status();
      if (reply.structuredContent.connected) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.deepEqual(reply.structuredContent, { connected: true, grouped: false });
    assert.equal(forwarded, 1);
    const bad = await client.callTool({ name: "firefox_navigate", arguments: { tab: "not-a-handle", url: "https://example.org" } });
    assert.equal(bad.isError, true);
    assert.equal(forwarded, 1);
    const exited = once(host, "exit");
    host.stdin.end();
    await exited;
    assert.equal((await status()).structuredContent.connected, false);
  } finally {
    await client.close();
    if (host?.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit");
      host.kill();
      await exited;
    }
    await rm(runtime, { force: true, recursive: true });
  }
});
