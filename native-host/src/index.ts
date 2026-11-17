import { lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { EXTENSION_ID, changesPage, requestSchema, responseSchema, type Request, type Response } from "@chatgpt-firefox/protocol";
import { FrameReader, frame, socketPath } from "@chatgpt-firefox/protocol/socket";

// Firefox passes the add-on ID after the path to the native host manifest.
if (process.argv[3] !== EXTENSION_ID) {
  console.error("Firefox did not supply the expected extension ID.");
  process.exit(1);
}

const transactions = new FrameReader();
let pending: { request: Request; socket: Socket; timer: NodeJS.Timeout } | undefined;
const clients = new Set<Socket>();
const server = createServer(socket => {
  if (clients.size >= 8) return socket.destroy();
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => socket.destroy());
  socket.setTimeout(18_000, () => socket.destroy());
  const reader = new FrameReader();
  let receivedRequest = false;
  socket.on("data", chunk => {
    try {
      reader.push(chunk, message => {
        if (receivedRequest) throw new Error("Expected one request per connection.");
        receivedRequest = true;
        const request = requestSchema.parse(message);
        if (pending) {
          reply(socket, { id: request.id, ok: false, error: { code: "BUSY", message: "Wait for the current Firefox command to finish." } });
          return;
        }
        const timer = setTimeout(() => {
          const code = changesPage(request.method) ? "OUTCOME_UNKNOWN" : "TIMEOUT";
          finish({ id: request.id, ok: false, error: { code, message: "Firefox did not reply in time. Check page state before retrying an action." } });
        }, 15_000);
        pending = { request, socket, timer };
        process.stdout.write(frame(request));
      });
    } catch {
      socket.destroy();
    }
  });
});

function reply(socket: Socket, response: Response): void {
  if (!socket.destroyed) socket.end(frame(response));
}

function finish(response: Response): void {
  if (pending?.request.id !== response.id) return;
  const { socket, timer } = pending;
  pending = undefined;
  clearTimeout(timer);
  reply(socket, response);
}

function stop(): void {
  if (pending) clearTimeout(pending.timer);
  for (const socket of clients) socket.destroy();
  server.close();
  process.stdin.pause();
}

async function listen(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  const existing = await lstat(path);
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("Invalid bridge socket.");
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1000, () => probe.destroy(new Error("Existing socket did not respond.")));
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Another Firefox window or profile has an active bridge."));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  const current = await lstat(path);
  if (current.ino !== existing.ino || current.dev !== existing.dev) throw new Error("Bridge socket changed.");
  await unlink(path);
}

try {
  const path = await socketPath(true);
  try {
    await listen(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await removeStaleSocket(path);
    await listen(path);
  }
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      transactions.push(chunk, message => finish(responseSchema.parse(message)));
    } catch {
      console.error("Firefox sent an invalid bridge message.");
      stop();
    }
  });
  process.stdin.on("end", stop);
  process.stdout.on("error", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not start the Firefox bridge.");
  process.exitCode = 1;
}
