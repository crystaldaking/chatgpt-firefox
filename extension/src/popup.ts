import { hostPattern, webUrl } from "@chatgpt-firefox/protocol";

type Status = { connected: boolean; grouped: boolean; approved: string[]; pending: string[]; ok: boolean; message?: string };
const connection = document.querySelector<HTMLButtonElement>("#connection")!;
const statusText = document.querySelector<HTMLElement>("#status")!;
const message = document.querySelector<HTMLElement>("#message")!;
const sites = document.querySelector<HTMLUListElement>("#sites")!;
let connected = false;
let activeRequest = false;
let renderedSites = "";

async function command(input: object): Promise<Status> {
  return await browser.runtime.sendMessage(input) as Status;
}

function render(status: Status): void {
  connected = status.connected;
  statusText.textContent = connected ? (status.grouped ? "Codex group ready" : "Waiting for a workspace tab") : "Disconnected";
  connection.textContent = connected ? "Stop access" : "Connect Codex";
  if (!activeRequest) connection.disabled = false;
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
        return granted ? command({ type: "approve", origin }) : { ...status, message: "Site permission was declined." };
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
  try {
    const status = await action();
    render(status);
    message.textContent = status.message ?? "";
  } catch {
    message.textContent = "Could not contact the extension.";
  } finally {
    activeRequest = false;
    connection.disabled = false;
  }
}

connection.addEventListener("click", () => {
  if (activeRequest) return;
  void update(async () => {
    if (connected) return command({ type: "stop" });
    const window = await browser.windows.getCurrent();
    return command({ type: "connect", windowId: window.id });
  });
});

async function refresh(): Promise<void> {
  if (activeRequest) return;
  try {
    const status = await command({ type: "status" });
    if (activeRequest) return;
    render(status);
    if (status.message) message.textContent = status.message;
  } catch {
    message.textContent = "Could not contact the extension.";
  }
}

void browser.action.setBadgeText({ text: "" });
void refresh();
setInterval(() => { void refresh(); }, 1000);
