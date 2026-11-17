import {
  NATIVE_HOST_NAME, OperationError, hostPattern, requestSchema, webUrl, type Request, type Response,
} from "@chatgpt-firefox/protocol";
import { runPageTask } from "./page.js";

type Entry = { handle: string; tabId: number; opened: boolean; previousGroup: number | undefined };
type Session = {
  windowId: number;
  groupId?: number;
  port: browser.runtime.Port;
  entries: Map<string, Entry>;
  approved: Set<string>;
  pending: Set<string>;
  busy: boolean;
};

const noConnection = () => new OperationError("DISCONNECTED", "Select Connect Codex in the Firefox extension.");
const outOfScope = () => new OperationError("OUT_OF_SCOPE", "The tab is outside the current Firefox workspace.");

export class Workspace {
  private session?: Session;
  private connectionError?: string;

  status() {
    const session = this.session;
    return {
      connected: Boolean(session),
      windowId: session?.windowId,
      grouped: session?.groupId !== undefined,
      approved: [...session?.approved ?? []],
      pending: [...session?.pending ?? []],
      message: this.connectionError,
    };
  }

  async connect(windowId: number): Promise<void> {
    const window = await browser.windows.get(windowId);
    if (window.type !== "normal" || window.incognito) throw outOfScope();
    if (this.session?.windowId === windowId) return;
    if (this.session) throw new OperationError("BUSY", "Stop the existing workspace before connecting another window.");
    const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    const session: Session = { windowId, port, entries: new Map(), approved: new Set(), pending: new Set(), busy: false };
    this.session = session;
    this.connectionError = undefined;
    port.onMessage.addListener(value => { void this.onRequest(session, value); });
    port.onDisconnect.addListener(() => {
      if (this.session !== session) return;
      this.session = undefined;
      this.connectionError = "Firefox lost the local bridge. Check the native host installation and reconnect.";
    });
  }

  stop(): void {
    const session = this.session;
    this.session = undefined;
    this.connectionError = undefined;
    session?.port.disconnect();
  }

  windowClosed(windowId: number): void {
    if (this.session?.windowId === windowId) this.stop();
  }

  groupRemoved(groupId: number): void {
    if (this.session?.groupId !== groupId || !this.session) return;
    this.session.groupId = undefined;
    this.session.entries.clear();
  }

  tabLeft(tabId: number): void {
    const entries = this.session?.entries;
    if (!entries) return;
    for (const entry of entries.values()) {
      if (entry.tabId === tabId) entries.delete(entry.handle);
    }
  }

  tabUpdated(tabId: number, tab: browser.tabs.Tab): void {
    if (tab.groupId !== this.session?.groupId) this.tabLeft(tabId);
  }

  async approve(origin: string): Promise<void> {
    const session = this.current();
    const url = webUrl(origin);
    if (!session.pending.has(url.origin) || !await browser.permissions.contains({ origins: [hostPattern(url)] })) {
      throw new OperationError("SITE_PERMISSION_REQUIRED", "Firefox has not approved this site.", url.origin);
    }
    this.assertCurrent(session);
    session.approved.add(url.origin);
    session.pending.delete(url.origin);
  }

  async revoke(origin: string): Promise<void> {
    const session = this.current();
    const url = webUrl(origin);
    session.approved.delete(url.origin);
    const pattern = hostPattern(url);
    if (![...session.approved].some(approved => hostPattern(webUrl(approved)) === pattern)) {
      await browser.permissions.remove({ origins: [pattern] });
    }
  }

  removeHostPermissions(patterns: string[]): void {
    const session = this.session;
    if (!session) return;
    for (const origin of session.approved) {
      if (patterns.includes(hostPattern(webUrl(origin)))) session.approved.delete(origin);
    }
  }

  async toggleShare(tab: browser.tabs.Tab): Promise<void> {
    const session = this.current();
    if (tab.id === undefined || tab.windowId !== session.windowId || tab.incognito || tab.pinned) throw outOfScope();
    if (session.busy) throw new OperationError("BUSY", "Wait for the current Firefox command to finish.");
    session.busy = true;
    try {
      await this.toggleShareInSession(session, tab, tab.id);
    } finally {
      session.busy = false;
    }
  }

  private async toggleShareInSession(session: Session, tab: browser.tabs.Tab, tabId: number): Promise<void> {
    const entry = [...session.entries.values()].find(candidate => candidate.tabId === tab.id);
    if (entry) {
      session.entries.delete(entry.handle);
      if (tab.groupId !== session.groupId) return;
      const group = entry.previousGroup === undefined ? undefined
        : await browser.tabGroups.get(entry.previousGroup).catch(() => undefined);
      this.assertCurrent(session);
      if (group && group.windowId === tab.windowId) await browser.tabs.group({ tabIds: tabId, groupId: group.id });
      else await browser.tabs.ungroup(tabId);
      return;
    }
    if (!tab.url) throw outOfScope();
    const url = webUrl(tab.url);
    if (!session.approved.has(url.origin)) this.queueApproval(session, url.origin);
    await this.addTab(session, tab, false);
  }

  private current(): Session {
    if (!this.session) throw noConnection();
    return this.session;
  }

  private assertCurrent(session: Session, entry?: Entry): void {
    if (session !== this.session) throw noConnection();
    if (entry && session.entries.get(entry.handle) !== entry) throw outOfScope();
  }

  private async onRequest(session: Session, value: unknown): Promise<void> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success || this.session !== session) return;
    const request = parsed.data;
    if (session.busy) {
      session.port.postMessage({ id: request.id, ok: false, error: { code: "BUSY", message: "A Firefox command is already in progress." } });
      return;
    }
    session.busy = true;
    let response: Response;
    try {
      const result = await this.dispatch(session, request);
      this.assertCurrent(session);
      response = { id: request.id, ok: true, result };
    } catch (error) {
      const reason = error instanceof OperationError
        ? error
        : new OperationError("PAGE_UNAVAILABLE", "Firefox could not complete the command. Check the workspace tab.");
      response = { id: request.id, ok: false, error: reason.details() };
    } finally {
      session.busy = false;
    }
    if (this.session === session) session.port.postMessage(response);
  }

  private queueApproval(session: Session, origin: string): void {
    if (session.pending.has(origin)) return;
    const oldest = session.pending.values().next().value;
    if (session.pending.size >= 20 && oldest !== undefined) session.pending.delete(oldest);
    session.pending.add(origin);
  }

  private async requireSite(session: Session, url: URL): Promise<void> {
    const pattern = hostPattern(url);
    const allowed = session.approved.has(url.origin) && await browser.permissions.contains({ origins: [pattern] });
    this.assertCurrent(session);
    if (allowed && session.approved.has(url.origin)) return;
    session.approved.delete(url.origin);
    this.queueApproval(session, url.origin);
    throw new OperationError("SITE_PERMISSION_REQUIRED", "Approve this site from the Firefox extension, then retry.", url.origin);
  }

  private async addTab(session: Session, tab: browser.tabs.Tab, opened: boolean): Promise<Entry> {
    if (tab.id === undefined) throw outOfScope();
    let groupId = session.groupId;
    if (groupId !== undefined && !await browser.tabGroups.get(groupId).catch(() => undefined)) groupId = undefined;
    this.assertCurrent(session);
    const newGroup = groupId === undefined;
    if (tab.groupId !== groupId || newGroup) groupId = await browser.tabs.group({ tabIds: tab.id, groupId });
    if (groupId === undefined) throw outOfScope();
    this.assertCurrent(session);
    session.groupId = groupId;
    if (newGroup) await browser.tabGroups.update(groupId, { title: "Codex", color: "blue", collapsed: !tab.active });
    this.assertCurrent(session);
    const entry = { handle: crypto.randomUUID(), tabId: tab.id, opened, previousGroup: tab.groupId !== groupId ? tab.groupId : undefined };
    session.entries.set(entry.handle, entry);
    return entry;
  }

  private async inWorkspace(session: Session, entry: Entry, background = false): Promise<browser.tabs.Tab> {
    this.assertCurrent(session, entry);
    const tab = await browser.tabs.get(entry.tabId).catch(() => undefined);
    this.assertCurrent(session, entry);
    if (!tab || session.groupId === undefined || tab.windowId !== session.windowId || tab.groupId !== session.groupId || tab.incognito) {
      session.entries.delete(entry.handle);
      throw outOfScope();
    }
    if (background && tab.active) {
      throw new OperationError("USER_ACTION_REQUIRED", "Switch away from the workspace tab before continuing.");
    }
    return tab;
  }

  private async navigate(session: Session, entry: Entry, url: URL) {
    await this.requireSite(session, url);
    const tab = await this.inWorkspace(session, entry, true);
    if (tab.url === url.href && tab.status === "complete") return { tab: entry.handle, url: url.href };
    const previous = tab.url?.split("#")[0];
    const sameDocument = previous === url.href.split("#")[0] && tab.status === "complete";
    let loaded: (complete: boolean) => void;
    const completed = new Promise<boolean>(resolve => { loaded = resolve; });
    let startedLoading = false;
    const listener = (tabId: number, change: browser.tabs._OnUpdatedChangeInfo, updated: browser.tabs.Tab) => {
      if (tabId !== entry.tabId) return;
      if (change.status === "loading") startedLoading = true;
      if (change.status === "complete" && updated.url && updated.url !== "about:blank"
        && (startedLoading || updated.url !== tab.url)) loaded(true);
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => loaded(false), 10_000);
    try {
      this.assertCurrent(session, entry);
      if (!session.approved.has(url.origin)) throw new OperationError("SITE_PERMISSION_REQUIRED", "Approve the destination site.", url.origin);
      await browser.tabs.update(entry.tabId, { url: url.href });
      if (!sameDocument && !await completed) throw new OperationError("OUTCOME_UNKNOWN", "Navigation may still be in progress. Check the tab before retrying.");
      const destination = await this.inWorkspace(session, entry);
      const finalUrl = webUrl(destination.url ?? url.href);
      await this.requireSite(session, finalUrl);
      return { tab: entry.handle, url: finalUrl.href };
    } finally {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
    }
  }

  private async dispatch(session: Session, request: Request): Promise<Record<string, unknown>> {
    if (request.method === "firefox_status") return this.status();
    if (request.method === "firefox_list_tabs") {
      const tabs = [];
      for (const entry of session.entries.values()) {
        const tab = await this.inWorkspace(session, entry).catch(() => undefined);
        if (!tab) continue;
        const url = URL.parse(tab.url ?? "");
        const showSite = url && session.approved.has(url.origin) && await browser.permissions.contains({ origins: [hostPattern(url)] });
        tabs.push({ tab: entry.handle, active: tab.active, opened: entry.opened, ...(showSite && { title: tab.title?.slice(0, 512), url: url.href }) });
      }
      return { tabs };
    }
    if (request.method === "firefox_open_tab") {
      const url = webUrl(request.args.url);
      await this.requireSite(session, url);
      this.assertCurrent(session);
      const tab = await browser.tabs.create({ active: false, windowId: session.windowId, url: "about:blank" });
      const entry = await this.addTab(session, tab, true);
      return this.navigate(session, entry, url);
    }

    const entry = session.entries.get(request.args.tab);
    if (!entry) throw outOfScope();
    if (request.method === "firefox_navigate") return this.navigate(session, entry, webUrl(request.args.url));
    const tab = await this.inWorkspace(session, entry, request.method !== "firefox_snapshot");
    if (request.method === "firefox_close_tab") {
      if (!entry.opened) throw new OperationError("OUT_OF_SCOPE", "Return shared tabs through the Firefox tab menu.");
      this.assertCurrent(session, entry);
      await browser.tabs.remove(entry.tabId);
      session.entries.delete(entry.handle);
      return { closed: true };
    }
    if (tab.status !== "complete" || tab.discarded) throw new OperationError("PAGE_UNAVAILABLE", "Wait until the workspace page has loaded.");
    const url = webUrl(tab.url ?? "");
    await this.requireSite(session, url);
    const current = await this.inWorkspace(session, entry, request.method !== "firefox_snapshot");
    if (current.url !== url.href) throw new OperationError("STALE_SNAPSHOT", "The workspace page navigated. Take a fresh snapshot.");
    const task = request.method === "firefox_snapshot"
      ? { kind: "snapshot" as const, url: url.href, snapshot: crypto.randomUUID() }
      : {
          kind: request.method === "firefox_click" ? "click" as const : "fill" as const,
          url: url.href,
          snapshot: request.args.snapshot,
          element: request.args.element,
          value: "value" in request.args ? request.args.value : undefined,
          origins: [...session.approved],
        };
    this.assertCurrent(session, entry);
    if (!session.approved.has(url.origin)) throw new OperationError("SITE_PERMISSION_REQUIRED", "Approve this site from Firefox.", url.origin);
    const [execution] = await browser.scripting.executeScript({ target: { tabId: entry.tabId, frameIds: [0] }, func: runPageTask, args: [task] }).catch(() => []);
    if (!execution?.result) {
      if (task.kind !== "snapshot") throw new OperationError("OUTCOME_UNKNOWN", "Check the page before repeating this action.");
      throw new OperationError("PAGE_UNAVAILABLE", "Firefox could not access the main document.");
    }
    this.assertCurrent(session, entry);
    if (task.kind === "snapshot" && !session.approved.has(url.origin)) {
      throw new OperationError("SITE_PERMISSION_REQUIRED", "This site permission was revoked.", url.origin);
    }
    const result = execution.result as ReturnType<typeof runPageTask>;
    if (!result.ok) throw new OperationError(result.code, result.message);
    return result.result;
  }
}
