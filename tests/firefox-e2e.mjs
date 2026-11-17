import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const executable = process.env.CHATGPT_FIREFOX_BINARY ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const scratch = await mkdtemp("/tmp/cgf-firefox-");
const profile = join(scratch, "profile");
const addon = join(scratch, "addon");
const env = { ...process.env, CHATGPT_FIREFOX_RUNTIME_DIR: join(scratch, "socket") };
let firefox, connection, browserLog = "";
const client = new Client({ name: "firefox-e2e", version: "1.0.0" });
let resolvePopup;
const popupReady = new Promise(resolveReady => { resolvePopup = resolveReady; });
let nextCommand, waitingPopup, resolveCommand;
const activations = [];
const server = createServer(async (request, response) => {
  if (request.url === "/command" && request.method === "GET") {
    if (nextCommand) {
      response.end(JSON.stringify(nextCommand));
      nextCommand = undefined;
    } else {
      waitingPopup = response;
    }
    return;
  }
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/extension") resolvePopup();
    if (request.url === "/reply") resolveCommand(JSON.parse(body));
    if (request.url === "/activation") activations.push(JSON.parse(body));
    response.end("OK");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/personal") {
    response.setHeader("Set-Cookie", "fixture_session=ok; Path=/; HttpOnly; SameSite=Lax");
    response.end('<title>Personal</title><input id="typing">');
  } else if (request.url === "/workspace" && request.headers.cookie?.includes("fixture_session=ok")) {
    response.end('<title>Signed-in fixture</title><h1>Private test page</h1><input aria-label="Note" oninput="document.querySelector(\'output\').textContent=this.value"><input type="password" value="hidden-fixture"><output></output><a href="/done">Continue</a><a href="/done" target="_blank">New tab</a>');
  } else if (request.url === "/done") {
    response.end("<title>Complete</title><h1>Navigation succeeded</h1>");
  } else {
    response.writeHead(403).end("Sign-in required");
  }
}).listen(0, "127.0.0.1");

function timeout(promise, description, duration = 12_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(description)), duration);
  })]).finally(() => clearTimeout(timer));
}

async function poll(action, predicate, label) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await action();
    if (predicate(result)) return result;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for " + label);
}

function popupCommand(command) {
  return timeout(new Promise(resolveReply => {
    resolveCommand = resolveReply;
    if (waitingPopup) {
      waitingPopup.end(JSON.stringify(command));
      waitingPopup = undefined;
    } else {
      nextCommand = command;
    }
  }), "The fixture popup did not reply to " + command.type);
}

try {
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  await mkdir(profile);
  await cp(resolve("dist/extension"), addon, { recursive: true });
  const manifestPath = join(addon, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // This test-only host grant makes the permission flow runnable in a headless browser.
  manifest.host_permissions = ["http://127.0.0.1/*"];
  manifest.background.scripts.push("observe.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(addon, "observe.js"), [
    "const fixture = " + JSON.stringify(origin) + ";",
    'void browser.tabs.create({ url: browser.runtime.getURL("popup.html"), active: false });',
    'browser.tabs.onActivated.addListener(info => { void fetch(fixture + "/activation", { method: "POST", body: JSON.stringify(info) }); });',
  ].join("\n"));
  const popupPath = join(addon, "popup.html");
  const popupHtml = await readFile(popupPath, "utf8");
  await writeFile(popupPath, popupHtml.replace("</body>", '<script src="test-popup.js"></script></body>'));
  await writeFile(join(addon, "test-popup.js"), [
    "const endpoint = " + JSON.stringify(origin) + ";",
    `void (async () => {
      await fetch(endpoint + "/extension", { method: "POST" });
      while (true) {
        const response = await fetch(endpoint + "/command");
        const command = await response.json();
        const result = command.type === "inspect"
          ? (await browser.tabGroups.query({ title: "Codex" })).map(group => ({ collapsed: group.collapsed }))
          : command.type === "connect"
          ? await browser.runtime.sendMessage({ type: "connect", windowId: (await browser.windows.getCurrent()).id })
          : await browser.runtime.sendMessage(command);
        await fetch(endpoint + "/reply", { method: "POST", body: JSON.stringify(result) });
      }
    })();`,
  ].join("\n"));
  await writeFile(join(profile, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.startup.homepage", "about:blank");',
  ].join("\n"));
  firefox = spawn(executable, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0"], {
    env, stdio: ["ignore", "ignore", "pipe"],
  });
  const address = await timeout(new Promise((resolveReady, reject) => {
    firefox.once("error", reject);
    firefox.stderr.on("data", chunk => {
      browserLog += chunk;
      const match = browserLog.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (match) resolveReady(match[1]);
    });
    firefox.once("exit", code => reject(new Error("Firefox exited: " + code)));
  }), "Firefox did not start.");
  connection = new WebSocket(address + "/session");
  await timeout(once(connection, "open"), "Could not connect to Firefox.");
  let sequence = 0;
  const listeners = new Map();
  connection.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    listeners.get(message.id)?.(message);
  });
  function bidi(method, params) {
    const id = ++sequence;
    return timeout(new Promise((resolveCommand, reject) => {
      listeners.set(id, message => {
        if (message.type === "error") reject(new Error(method + ": " + message.message));
        else resolveCommand(message.result);
      });
      connection.send(JSON.stringify({ id, method, params }));
    }), "Firefox timed out on " + method).finally(() => listeners.delete(id));
  }
  const { capabilities } = await bidi("session.new", { capabilities: {} });
  const { contexts: [personal] } = await bidi("browsingContext.getTree", {});
  const navigate = url => bidi("browsingContext.navigate", { context: personal.context, url, wait: "complete" });
  async function evaluate(expression) {
    const reply = await bidi("script.evaluate", { expression, target: { context: personal.context }, awaitPromise: true });
    if (reply.type !== "success") throw new Error("Fixture browser script failed.");
    return reply.result.value;
  }
  await bidi("webExtension.install", { extensionData: { type: "path", path: addon } });
  await timeout(popupReady, "The extension did not start.");
  assert.equal((await popupCommand({ type: "connect" })).connected, true);
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["dist/mcp-server.mjs"], env, stderr: "inherit",
  }));
  async function call(name, args = {}, code) {
    const result = await client.callTool({ name: "firefox_" + name, arguments: args });
    if (code) assert.equal(result.structuredContent?.code, code, JSON.stringify(result));
    else assert.equal(Boolean(result.isError), false, JSON.stringify(result));
    return result.structuredContent;
  }
  await poll(() => call("status"), value => value.connected, "the native host");
  const url = origin + "/workspace";
  await call("open_tab", { url }, "SITE_PERMISSION_REQUIRED");
  assert.equal((await popupCommand({ type: "approve", origin })).ok, true);
  await poll(() => call("status"), value => value.approved.includes(origin), "site approval");
  await navigate(origin + "/personal");
  await evaluate('const field = document.querySelector("#typing"); field.value = "Personal text"; field.focus(); field.setSelectionRange(1, 4);');
  const activationsBefore = activations.length;
  const { tab } = await call("open_tab", { url });
  const { tabs } = await call("list_tabs");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].active, false);
  assert.equal((await call("status")).grouped, true);
  assert.deepEqual(await popupCommand({ type: "inspect" }), [{ collapsed: true }]);
  await call("snapshot", { tab: randomUUID() }, "OUT_OF_SCOPE");
  const first = await call("snapshot", { tab });
  assert.match(first.text, /Private test page/);
  assert.doesNotMatch(JSON.stringify(first), /hidden-fixture/);
  const field = first.elements.find(element => element.label === "Note");
  const filled = await call("fill", { tab, snapshot: first.snapshot, element: field.id, value: "Background edit" });
  assert.equal(filled.accepted, true);
  await call("fill", { tab, snapshot: first.snapshot, element: field.id, value: "Duplicate" }, "STALE_SNAPSHOT");
  const second = await call("snapshot", { tab });
  assert.match(second.text, /Background edit/);
  const newTab = second.elements.find(element => element.label === "New tab");
  await call("click", { tab, snapshot: second.snapshot, element: newTab.id }, "USER_ACTION_REQUIRED");
  const link = second.elements.find(element => element.label === "Continue");
  await call("click", { tab, snapshot: second.snapshot, element: link.id });
  const { url: destination } = await call("navigate", { tab, url: origin + "/done" });
  assert.equal(destination, origin + "/done");
  assert.match((await call("snapshot", { tab })).text, /Navigation succeeded/);
  assert.equal(await evaluate('JSON.stringify([document.hidden, document.activeElement.id, document.activeElement.value, document.activeElement.selectionStart, document.activeElement.selectionEnd])'),
    JSON.stringify([false, "typing", "Personal text", 1, 4]));
  assert.equal(activations.length, activationsBefore);
  await call("close_tab", { tab });
  assert.deepEqual((await call("list_tabs")).tabs, []);
  assert.equal((await popupCommand({ type: "stop" })).connected, false);
  await poll(() => call("status"), value => !value.connected, "disconnection");
  console.log("Firefox " + capabilities.browserVersion + " passed the background workspace test.");
} catch (error) {
  console.error(error);
  console.error(browserLog.slice(-4000));
  process.exitCode = 1;
} finally {
  await client.close();
  connection?.close();
  if (firefox?.pid && firefox.exitCode === null && firefox.signalCode === null) {
    const exited = once(firefox, "exit");
    firefox.kill();
    await exited;
  }
  server.closeAllConnections();
  server.close();
  await rm(scratch, { force: true, recursive: true });
}
