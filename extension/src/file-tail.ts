/**
 * Read only the tail of a file (fd + position). Never slurps the whole file.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface FileTail {
  text: string;
  size: number;
}

/** Last `maxBytes` bytes, cut on a UTF-8 boundary. Returns null if the file cannot be opened. */
export function readFileTail(path: string, maxBytes: number): FileTail | null {
  const cap = Math.max(0, Math.floor(maxBytes));
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0 || cap === 0) return { text: "", size };
    const start = Math.max(0, size - cap);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    const raw = buf.subarray(0, off);
    const text = (start > 0 ? skipPartialUtf8(raw) : raw).toString("utf8");
    return { text, size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function skipPartialUtf8(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && (buf[i] & 0b1100_0000) === 0b1000_0000) i++;
  return buf.subarray(i);
}
