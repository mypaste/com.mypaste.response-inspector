/**
 * The host's surface bridge, as seen from inside the response page.
 *
 * The document runs in a sandboxed frame with an opaque origin and holds no
 * host binding: it can read the invoked item, receive the application's
 * resolved theme, ask the host to copy text, close the container, and invoke
 * one of its own package's internal commands (D-1084). The inspection itself
 * runs in this package's Go runtime; the page opens no socket of its own.
 * Every request carries exactly the fields it needs.
 */

export type SurfaceTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

interface ResultMessage extends BridgeResult {
  requestId: number;
  output?: string;
}

export interface SurfaceDelivery {
  item: SurfaceTextItem;
}

export interface InvokeResult extends BridgeResult {
  output?: string;
}

export interface SurfaceBridge {
  readonly delivery: SurfaceDelivery | null;
  /** Registers the one receiver for the delivery; it fires at most once. */
  onItem(listener: (delivery: SurfaceDelivery) => void): void;
  /** Runs one internal command of this package against `text`. */
  invoke(pluginId: string, commandId: string, text: string): Promise<InvokeResult>;
  copy(text: string): Promise<BridgeResult>;
  /** Asks the host to close the surface; the page owns the whole card (D-1097). */
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The application's resolved colour scheme (D-1042). */
type SurfaceScheme = "light" | "dark";

/** Resolved host tokens; keys are the host's CSS names without `--` (D-1043). */
type SurfaceTokens = Record<string, string>;

interface ParsedTheme {
  scheme: SurfaceScheme;
  tokens: SurfaceTokens;
}

/** The only shape a token name may take once it is prefixed with `--mp-`. */
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;

function parseTheme(data: unknown): ParsedTheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  if (data.scheme !== "light" && data.scheme !== "dark") return null;
  const tokens: SurfaceTokens = {};
  if (isRecord(data.tokens)) {
    for (const [name, value] of Object.entries(data.tokens)) {
      if (!TOKEN_NAME.test(name)) continue;
      if (typeof value !== "string" || value === "" || value.length > 160) continue;
      tokens[name] = value;
    }
  }
  return { scheme: data.scheme, tokens };
}

function applyTheme(theme: ParsedTheme): void {
  const root = document.documentElement;
  root.dataset.scheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--mp-${name}`, value);
  }
}

function parseTextItem(value: unknown): SurfaceTextItem | null {
  if (!isRecord(value) || value.kind !== "text" ||
    typeof value.title !== "string" || typeof value.text !== "string") {
    return null;
  }
  return { kind: "text", title: value.title, text: value.text };
}

function parseItem(data: unknown): SurfaceTextItem | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  return parseTextItem(data.item);
}

/**
 * connectSurface wires the bridge and tells the host the document is ready.
 * The host delivers the item only after that, so a document that renders first
 * and asks later would race a host that already delivered.
 */
export function connectSurface(): SurfaceBridge {
  let delivery: SurfaceDelivery | null = null;
  const listeners: ((delivery: SurfaceDelivery) => void)[] = [];
  const pending = new Map<number, (result: ResultMessage) => void>();
  let nextRequest = 1;
  let delivering = false;

  function post(message: unknown): void {
    parent.postMessage(message, "*");
  }

  function request(message: Record<string, unknown>): Promise<ResultMessage> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      post({ ...message, v: 1, requestId });
    });
  }

  function deliver(item: SurfaceTextItem): void {
    if (delivering) return;
    delivering = true;
    delivery = { item };
    for (const listener of listeners) listener(delivery);
    listeners.length = 0;
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    const item = parseItem(data);
    if (item) {
      deliver(item);
      return;
    }
    const theme = parseTheme(data);
    if (theme) {
      applyTheme(theme);
      return;
    }
    if (!isRecord(data) || data.v !== 1 || data.type !== "result") return;
    if (typeof data.requestId !== "number") return;
    const resolve = pending.get(data.requestId);
    if (!resolve) return;
    pending.delete(data.requestId);
    resolve({
      requestId: data.requestId,
      ok: data.ok === true,
      id: typeof data.id === "number" ? data.id : undefined,
      message: typeof data.message === "string" ? data.message : undefined,
      output: typeof data.output === "string" ? data.output : undefined,
    });
  });

  post({ v: 1, type: "ready" });

  return {
    get delivery() {
      return delivery;
    },
    onItem(listener) {
      if (delivery) {
        listener(delivery);
        return;
      }
      listeners.push(listener);
    },
    async invoke(pluginId, commandId, text) {
      const result = await request({ type: "invoke", pluginId, commandId, text });
      return { ok: result.ok, id: result.id, message: result.message, output: result.output };
    },
    async copy(text) {
      const result = await request({ type: "copy", text });
      return { ok: result.ok, id: result.id, message: result.message };
    },
    close() {
      post({ v: 1, type: "close" });
    },
  };
}
