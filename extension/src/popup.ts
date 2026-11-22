import { hostPattern, webUrl } from "@chatgpt-firefox/protocol";
import type { Workspace } from "./workspace.js";

type Status = ReturnType<Workspace["status"]> & { ok: boolean };
const connection = document.querySelector<HTMLButtonElement>("#connection")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const statusText = document.querySelector<HTMLElement>("#status")!;
const message = document.querySelector<HTMLElement>("#message")!;
const sites = document.querySelector<HTMLUListElement>("#sites")!;
let accessActive = false;
let activeRequest = false;
let renderedSites = "";
let actionMessage = "";

async function command(input: object): Promise<Status> {
  return await browser.runtime.sendMessage(input) as Status;
}

function render(status: Status): void {
  const statuses: Record<Status["connection"], string> = {
    stopped: "Disconnected",
    connecting: "Starting the local bridge…",
    connected: status.grouped ? "Codex group ready" : "Waiting for a workspace tab",
    reconnecting: "Restoring the local bridge…",
    unavailable: "Local bridge unavailable",
  };
  accessActive = status.connection !== "stopped";
  statusText.textContent = statuses[status.connection];
  connection.textContent = accessActive ? "Stop access" : "Connect Codex";
  retry.hidden = status.connection !== "unavailable";
  connection.disabled = activeRequest;
  retry.disabled = activeRequest;
  message.textContent = actionMessage || status.message || "";
  const siteList = JSON.stringify([status.pending, status.approved]);
  if (renderedSites === siteList) return;
  renderedSites = siteList;
  sites.replaceChildren();
  for (const [origin, approved] of [...status.pending.map(origin => [origin, false] as const), ...status.approved.map(origin => [origin, true] as const)]) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = origin;
    const button = document.createElement("button");
    button.textContent = approved ? "Revoke" : "Allow";
    button.setAttribute("aria-label", button.textContent + " " + origin);
    button.addEventListener("click", () => {
      if (activeRequest) return;
      // Firefox requires the permission request to start inside the click handler.
      void update(async () => {
        if (approved) return command({ type: "revoke", origin });
        const granted = await browser.permissions.request({ origins: [hostPattern(webUrl(origin))] });
        return granted ? command({ type: "approve", origin }) : { ...status, ok: false, message: "Site permission was declined." };
      });
    });
    item.append(label, button);
    sites.append(item);
  }
  document.querySelector<HTMLElement>("#permissions")!.hidden = sites.childElementCount === 0;
}

async function update(action: () => Promise<Status>): Promise<void> {
  activeRequest = true;
  connection.disabled = true;
  retry.disabled = true;
  actionMessage = "";
  try {
    const status = await action();
    if (!status.ok) actionMessage = status.message ?? "";
    render(status);
  } catch {
    actionMessage = "Could not contact the extension.";
    message.textContent = actionMessage;
  } finally {
    activeRequest = false;
    connection.disabled = false;
    retry.disabled = false;
  }
}

connection.addEventListener("click", () => {
  if (activeRequest) return;
  void update(async () => {
    if (accessActive) return command({ type: "stop" });
    const window = await browser.windows.getCurrent();
    return command({ type: "connect", windowId: window.id });
  });
});

retry.addEventListener("click", () => {
  if (!activeRequest) void update(() => command({ type: "retry" }));
});

async function refresh(): Promise<void> {
  if (activeRequest) return;
  try {
    const status = await command({ type: "status" });
    if (activeRequest) return;
    render(status);
  } catch {
    message.textContent = "Could not contact the extension.";
  }
}

void browser.action.setBadgeText({ text: "" });
void refresh();
setInterval(() => { void refresh(); }, 1000);
