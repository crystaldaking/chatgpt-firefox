import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MAX_FRAME_BYTES } from "./index.js";

export async function socketPath(create = false): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("A Unix user account is required.");
  const directory = process.env.CHATGPT_FIREFOX_RUNTIME_DIR ?? join("/tmp", "chatgpt-firefox-" + uid);
  const path = join(directory, "bridge.sock");
  if (!isAbsolute(directory) || Buffer.byteLength(path) >= 104) {
    throw new Error("Use a short absolute path for the local socket directory.");
  }
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    throw new Error("The socket directory must be owned by the current user with mode 0700.");
  }
  return path;
}

export function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error("Message exceeds the bridge size limit.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (value: unknown) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (length < 1 || length > MAX_FRAME_BYTES) throw new Error("Invalid frame size.");
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      onFrame(JSON.parse(body.toString("utf8")));
    }
  }
}
