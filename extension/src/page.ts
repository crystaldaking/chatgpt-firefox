type PageTask =
  | { kind: "snapshot"; url: string; snapshot: string }
  | { kind: "click" | "fill"; url: string; snapshot: string; element: number; value?: string; origins: string[] };

// Firefox serializes this function when it runs in the tab. Keep all runtime dependencies inside it.
export function runPageTask(task: PageTask) {
  type ElementInfo = { kind: "click" | "fill"; label: string; signature: string };
  type Snapshot = { id: string; url: string; elements: Map<number, { node: HTMLElement; signature: string }> };
  const scope = globalThis as typeof globalThis & { chatgptFirefoxSnapshot?: Snapshot };
  const stale = { ok: false, code: "STALE_SNAPSHOT", message: "The page or element changed. Take a fresh snapshot." } as const;
  const manual = { ok: false, code: "USER_ACTION_REQUIRED", message: "This element needs a manual action in Firefox." } as const;
  if (location.href !== task.url) return stale;

  function visible(element: HTMLElement): boolean {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
  }

  function label(element: HTMLElement): string {
    const inputLabel = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.labels?.[0]?.innerText || element.placeholder
      : element.innerText;
    return (element.getAttribute("aria-label") || inputLabel || element.title || element.tagName).trim().slice(0, 240);
  }

  function describe(element: HTMLElement): ElementInfo | undefined {
    if (!visible(element) || element.closest("[inert]") || element.matches(":disabled, [aria-disabled='true']")) return;
    let kind: ElementInfo["kind"];
    let detail = "";
    if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
      kind = "click";
      detail = JSON.stringify([element.href, element.target, element.hasAttribute("download")]);
    } else if (element instanceof HTMLButtonElement || element.matches("input[type=button], input[type=submit], [role=button]")) {
      kind = "click";
      detail = element.getAttribute("type") || "";
      if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.form) {
        detail = JSON.stringify([element.type, element.form.action, element.form.method, element.form.target,
          element.getAttribute("formaction"), element.getAttribute("formmethod"), element.getAttribute("formtarget")]);
      }
    } else if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && ["text", "search", "email", "tel", "url", "number"].includes(element.type))) {
      if (element.readOnly || /password|one-time-code|cc-/.test(element.autocomplete)) return;
      kind = "fill";
      detail = element.getAttribute("type") || "";
    } else {
      return;
    }
    const name = label(element);
    return { kind, label: name, signature: JSON.stringify([kind, name, detail]) };
  }

  function textFromPage(): string {
    if (!document.body) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node instanceof Element) {
        if (node.matches("script, style, template, noscript, input, textarea, select, [hidden], [aria-hidden=true], [contenteditable=true]")) {
          return NodeFilter.FILTER_REJECT;
        }
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    });
    let text = "";
    for (let index = 0; index < 2000 && text.length < 12_000; index++) {
      const node = walker.nextNode();
      if (!node) break;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const fragment = node.textContent?.slice(0, 12_000).replace(/\s+/g, " ").trim();
      if (fragment) text += (text ? "\n" : "") + fragment;
    }
    return text.slice(0, 12_000);
  }

  if (task.kind === "snapshot") {
    const elements: { id: number; kind: "click" | "fill"; label: string }[] = [];
    const snapshot: Snapshot = { id: task.snapshot, url: task.url, elements: new Map() };
    const candidates = document.querySelectorAll<HTMLElement>("a[href], button, input, textarea, [role=button]");
    for (let index = 0; index < Math.min(candidates.length, 600) && elements.length < 60; index++) {
      const node = candidates[index];
      if (!(node instanceof HTMLElement)) continue;
      const info = describe(node);
      if (!info) continue;
      const id = elements.length + 1;
      elements.push({ id, label: info.label, kind: info.kind });
      snapshot.elements.set(id, { node, signature: info.signature });
    }
    scope.chatgptFirefoxSnapshot = snapshot;
    return {
      ok: true,
      result: { snapshot: task.snapshot, title: document.title.slice(0, 512), url: location.href, text: textFromPage(), elements },
    } as const;
  }

  const snapshot = scope.chatgptFirefoxSnapshot;
  const entry = snapshot?.elements.get(task.element);
  if (snapshot?.id !== task.snapshot || snapshot.url !== task.url || !entry?.node.isConnected) return stale;
  if (!document.hidden) return { ok: false, code: "USER_ACTION_REQUIRED", message: "Switch away from this workspace tab before continuing." } as const;
  const element = entry.node;
  const info = describe(element);
  if (info?.kind !== task.kind || info.signature !== entry.signature) return stale;

  function permitsNavigation(href: string, target: string): boolean {
    const effectiveTarget = target || document.querySelector("base[target]")?.getAttribute("target") || "_self";
    const destination = URL.parse(href, location.href);
    return effectiveTarget.toLowerCase() === "_self" && destination !== null
      && ["http:", "https:"].includes(destination.protocol) && !destination.username && !destination.password
      && task.kind !== "snapshot" && task.origins.includes(destination.origin);
  }

  if (task.kind === "click") {
    if (element instanceof HTMLAnchorElement && (element.hasAttribute("download") || !permitsNavigation(element.href, element.target))) return manual;
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
      if (element.type === "submit" && element.form) {
        const form = element.form;
        const action = element.hasAttribute("formaction") ? element.formAction : form.action;
        const target = element.hasAttribute("formtarget") ? element.formTarget : form.target;
        if (!permitsNavigation(action, target)) return manual;
      }
    }
    scope.chatgptFirefoxSnapshot = undefined;
    element.click();
  } else {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setValue) return manual;
    scope.chatgptFirefoxSnapshot = undefined;
    setValue.call(element, task.value ?? "");
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, result: { performed: "fill", accepted: (element as HTMLInputElement).value === task.value } } as const;
  }
  return { ok: true, result: { performed: "click" } } as const;
}
