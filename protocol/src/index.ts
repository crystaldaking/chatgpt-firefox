import * as z from "zod";

export const VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const NATIVE_HOST_NAME = "io.github.crystaldaking.chatgpt_firefox";
export const EXTENSION_ID = "chatgpt-firefox@crystaldaking.github.io";
export const nativeReady = { kind: "ready", version: VERSION } as const;
export const nativeReadySchema = z.strictObject({
  kind: z.literal(nativeReady.kind),
  version: z.literal(nativeReady.version),
});

export const toolSchemas = {
  firefox_status: z.strictObject({}),
  firefox_list_tabs: z.strictObject({}),
  firefox_open_tab: z.strictObject({ url: z.string().min(1).max(4096) }),
  firefox_navigate: z.strictObject({ tab: z.uuid(), url: z.string().min(1).max(4096) }),
  firefox_snapshot: z.strictObject({ tab: z.uuid() }),
  firefox_click: z.strictObject({ tab: z.uuid(), snapshot: z.uuid(), element: z.number().int().positive() }),
  firefox_fill: z.strictObject({
    tab: z.uuid(),
    snapshot: z.uuid(),
    element: z.number().int().positive(),
    value: z.string().max(4096),
  }),
  firefox_close_tab: z.strictObject({ tab: z.uuid() }),
};

export type Method = keyof typeof toolSchemas;

function requestFor<M extends Method>(method: M) {
  return z.strictObject({
    version: z.literal(VERSION),
    id: z.uuid(),
    method: z.literal(method),
    args: toolSchemas[method],
  });
}

export const requestSchema = z.discriminatedUnion("method", [
  requestFor("firefox_status"),
  requestFor("firefox_list_tabs"),
  requestFor("firefox_open_tab"),
  requestFor("firefox_navigate"),
  requestFor("firefox_snapshot"),
  requestFor("firefox_click"),
  requestFor("firefox_fill"),
  requestFor("firefox_close_tab"),
]);

export const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: z.uuid(), ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    id: z.uuid(),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "DISCONNECTED", "PROTOCOL_ERROR", "BUSY", "OUTCOME_UNKNOWN", "TIMEOUT",
        "OUT_OF_SCOPE", "SITE_PERMISSION_REQUIRED", "INVALID_URL", "PAGE_UNAVAILABLE",
        "USER_ACTION_REQUIRED", "STALE_SNAPSHOT",
      ]),
      message: z.string().max(1024),
      origin: z.string().max(512).optional(),
    }),
  }),
]);

export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
export type BridgeError = Extract<Response, { ok: false }>["error"];

export class OperationError extends Error {
  constructor(readonly code: BridgeError["code"], message: string, readonly origin?: string) {
    super(message);
  }

  details(): BridgeError {
    return { code: this.code, message: this.message, ...(this.origin && { origin: this.origin }) };
  }
}

export function webUrl(raw: string): URL {
  const url = URL.parse(raw);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new OperationError("INVALID_URL", "Use an HTTP or HTTPS address without credentials.");
  }
  return url;
}

export function hostPattern(url: URL): string {
  return url.protocol + "//" + url.hostname + "/*";
}

export function changesPage(method: Method): boolean {
  return method !== "firefox_status" && method !== "firefox_list_tabs" && method !== "firefox_snapshot";
}
