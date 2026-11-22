import { OperationError } from "@chatgpt-firefox/protocol";
import { Workspace } from "./workspace.js";

const workspace = new Workspace();
const popupUrl = browser.runtime.getURL("popup.html");

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.url !== popupUrl || !message || typeof message !== "object") return;
  return handlePopup(message);
});

async function handlePopup(message: { type?: unknown; windowId?: unknown; origin?: unknown }) {
  try {
    if (message.type === "connect" && typeof message.windowId === "number") await workspace.connect(message.windowId);
    if (message.type === "retry") workspace.retry();
    if (message.type === "stop") workspace.stop();
    if (message.type === "approve" && typeof message.origin === "string") await workspace.approve(message.origin);
    if (message.type === "revoke" && typeof message.origin === "string") await workspace.revoke(message.origin);
    return { ...workspace.status(), ok: true };
  } catch (error) {
    return {
      ...workspace.status(),
      ok: false,
      message: error instanceof OperationError ? error.message : "Firefox could not update the workspace.",
    };
  }
}

const menuId = "chatgpt-firefox-share-tab";
browser.menus.create({ id: menuId, title: "Share or return tab in Codex workspace", contexts: ["tab"] }, () => {
  // Firefox can retain the menu entry when an event page reloads.
  void browser.runtime.lastError;
});
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== menuId || !tab) return;
  void workspace.toggleShare(tab).catch(() => browser.action.setBadgeText({ text: "!" }));
});
browser.windows.onRemoved.addListener(windowId => workspace.windowClosed(windowId));
browser.tabGroups.onRemoved.addListener(group => workspace.groupRemoved(group.id));
browser.tabs.onRemoved.addListener(tabId => workspace.tabLeft(tabId));
browser.tabs.onDetached.addListener(tabId => workspace.tabLeft(tabId));
browser.tabs.onUpdated.addListener((tabId, _change, tab) => workspace.tabUpdated(tabId, tab));
browser.permissions.onRemoved.addListener(permissions => workspace.removeHostPermissions(permissions.origins ?? []));
