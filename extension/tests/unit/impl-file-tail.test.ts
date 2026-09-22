/**
 * Tail reads must not slurp a huge file. A sparse 1GB file is cheap to create
 * on APFS; readFileSync of it is not.
 */
import { closeSync, ftruncateSync, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPreview } from "../../src/index";
import { readTaskFileTail } from "../../src/tui/task-output-paths";

const PATH = join(tmpdir(), `pbs-sparse-tail-${process.pid}`);
const SPARSE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const MARKER = "TAIL_MARKER_OK";

describe("tail reads of a sparse file", () => {
  afterAll(() => {
    try {
      unlinkSync(PATH);
    } catch {
      // already gone
    }
  });

  it("returns only the tail of a 1GiB file within 500ms", () => {
    const fd = openSync(PATH, "w+");
    try {
      ftruncateSync(fd, SPARSE_BYTES);
      const marker = Buffer.from(MARKER);
      writeSync(fd, marker, 0, marker.length, SPARSE_BYTES - marker.length);
    } finally {
      closeSync(fd);
    }

    const cap = 64 * 1024;
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const tail = readTaskFileTail(PATH, cap);
    const preview = readPreview(PATH, 4000);
    const elapsed = Date.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;

    expect(elapsed).toBeLessThan(200);
    // A whole-file read of the 1GiB sparse file allocates ~1GiB. The tail read must not.
    expect(heapDelta).toBeLessThan(32 * 1024 * 1024);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(cap + 80);
    expect(tail).toContain(MARKER);
    expect(preview.length).toBeLessThanOrEqual(4000);
    expect(preview).toContain(MARKER);
  });
});
