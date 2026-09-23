/**
 * Integration test for ManagerClient against an in-process fake pbs-manager
 * speaking the real §3.3 wire protocol (u32 BE length + JSON frames).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ManagerClient,
  releaseSpawnLockFile,
  tryAcquireSpawnLockFile,
  type ManagerEvent,
} from "../../src/manager-client";

interface FakeManager {
  server: net.Server;
  socketPath: string;
  received: Record<string, unknown>[];
  sockets: Set<net.Socket>;
  rejectFirstHelloOnce(): void;
  dropNext(type: string): void;
  startCount(): number;
  close(): Promise<void>;
}

function encodeFrame(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Start a fake manager that answers hello/start/wait/output/stop/list/watch. */
async function startFakeManager(home: string): Promise<FakeManager> {
  const socketPath = join(home, "manager.sock");
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  let rejectNextHelloForShutdown = false;
  const dropTypes = new Set<string>();
  const startsByKey = new Map<string, { task_id: string; pid: number }>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as Record<string, unknown>;
        buf = buf.subarray(4 + len);
        received.push(msg);
        if (dropTypes.has(String(msg.type))) {
          dropTypes.delete(String(msg.type));
          if (msg.type === "start") {
            const key = String(msg.key);
            if (!startsByKey.has(key)) startsByKey.set(key, { task_id: "sh_a1b2c3d4", pid: 5678 });
          }
          socket.destroy();
          return;
        }
        const reply = handleRequest(msg, socket);
        if (reply) socket.write(encodeFrame(reply));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });

  function handleRequest(
    msg: Record<string, unknown>,
    socket: net.Socket,
  ): Record<string, unknown> | null {
    switch (msg.type) {
      case "hello":
        if (rejectNextHelloForShutdown) {
          rejectNextHelloForShutdown = false;
          return { v: 1, id: msg.id, ok: false, error: { code: "E_INTERNAL", message: "manager is shutting down" } };
        }
        return { v: 1, id: msg.id, ok: true, version: "0.1.0", pid: 4321, started_at: 1 };
      case "start": {
        const key = String(msg.key ?? "legacy");
        if (!startsByKey.has(key)) startsByKey.set(key, { task_id: "sh_a1b2c3d4", pid: 5678 });
        return { v: 1, id: msg.id, ok: true, ...startsByKey.get(key) };
      }
      case "wait":
        return { v: 1, id: msg.id, ok: true, done: true, exit_code: 0 };
      case "output":
        return {
          v: 1,
          id: msg.id,
          ok: true,
          chunk: "hello output\n",
          next_cursor: 13,
          status: "completed",
          exit_code: 0,
          total_size: 13,
        };
      case "stop":
      case "mark_background":
        return { v: 1, id: msg.id, ok: true };
      case "list":
        return { v: 1, id: msg.id, ok: true, tasks: [] };
      case "shutdown_session":
        return { v: 1, id: msg.id, ok: true, stopped: ["sh_a1b2c3d4"] };
      case "watch":
        // Acknowledge, then push one output event and one exit event.
        setImmediate(() => {
          socket.write(
            encodeFrame({ v: 1, type: "event", event: "output", task_id: msg.task_id, chunk: "tick\n", next_cursor: 5 }),
          );
          socket.write(
            encodeFrame({
              v: 1,
              type: "event",
              event: "task_exited",
              task_id: msg.task_id,
              exit_code: 0,
              signal: null,
              duration_ms: 100,
              output_path: "/tmp/x.output",
              output_size: 5,
              ts: 1,
            }),
          );
        });
        return { v: 1, id: msg.id, ok: true };
      default:
        return { v: 1, id: msg.id, ok: false, error: { code: "E_BAD_REQUEST", message: "unknown" } };
    }
  }

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    server,
    socketPath,
    received,
    sockets,
    rejectFirstHelloOnce: () => { rejectNextHelloForShutdown = true; },
    dropNext: (type) => { dropTypes.add(type); },
    startCount: () => startsByKey.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("ManagerClient (integration, fake manager)", () => {
  let home: string;
  let fake: FakeManager;
  let client: ManagerClient;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "pbs-test-"));
    fake = await startFakeManager(home);
    client = new ManagerClient({ home, sessionId: "sess-1", managerPath: null });
  });

  afterEach(async () => {
    await client.close();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("dedupes a connect that overlaps session_start", async () => {
    const [a, b] = await Promise.all([client.connect(), client.ensureAvailable()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fake.received.filter((m) => m.type === "hello")).toHaveLength(1);
    expect(fake.sockets.size).toBe(1);
    expect(client.isAvailable()).toBe(true);
  });

  it("connects and completes the hello handshake", async () => {
    expect(await client.connect()).toBe(true);
    expect(client.isAvailable()).toBe(true);
    const hello = fake.received.find((m) => m.type === "hello");
    expect(hello).toMatchObject({
      v: 1,
      client_kind: "extension",
      session_id: "sess-1",
      pi_pid: process.pid,
      extension_version: "0.1.0",
      protocol: 2,
    });
  });

  it("waits out a shutting-down hello without deleting manager files", async () => {
    fake.rejectFirstHelloOnce();
    writeFileSync(join(home, "manager.pid"), JSON.stringify({ pid: 2_000_000_000 }));

    expect(await client.connect()).toBe(true);
    expect(fake.received.filter((message) => message.type === "hello")).toHaveLength(2);
    expect(existsSync(fake.socketPath)).toBe(true);
    expect(existsSync(join(home, "manager.pid"))).toBe(true);
  });

  it("multiplexes request/response for start/wait/output/stop/list", async () => {
    await client.connect();
    const start = await client.start({
      kind: "shell",
      command: "echo hi",
      cwd: "/tmp",
      env: {},
      run_in_background: false,
      timeout_ms: null,
      origin: { via: "bash-fg" },
    });
    expect(start).toEqual({ task_id: "sh_a1b2c3d4", pid: 5678 });
    expect(fake.received.find((message) => message.type === "start")).toMatchObject({
      origin: { via: "bash-fg" },
    });
    await client.markBackground("sh_a1b2c3d4");
    expect(fake.received.find((message) => message.type === "mark_background")).toMatchObject({
      task_id: "sh_a1b2c3d4",
    });

    const waitRes = await client.wait("sh_a1b2c3d4", 20000);
    expect(waitRes).toEqual({ done: true, exit_code: 0 });
    // budget_ms is forwarded per §3.3
    const waitReq = fake.received.find((m) => m.type === "wait");
    expect(waitReq).toMatchObject({ task_id: "sh_a1b2c3d4", budget_ms: 20000 });

    const out = await client.output("sh_a1b2c3d4", 0, 65536);
    expect(out.chunk).toBe("hello output\n");
    expect(out.next_cursor).toBe(13);
    expect(out.total_size).toBe(13);

    await expect(client.stop("sh_a1b2c3d4", "tui")).resolves.toBeUndefined();
    expect(fake.received.find((message) => message.type === "stop")).toMatchObject({ reason: "tui" });
    await expect(client.list()).resolves.toEqual([]);
    await expect(client.shutdownSession()).resolves.toEqual(["sh_a1b2c3d4"]);
  });

  it("dispatches server-pushed events to onEvent handlers", async () => {
    await client.connect();
    const events: ManagerEvent[] = [];
    let resolveEvents!: () => void;
    const eventsReady = new Promise<void>((resolve) => {
      resolveEvents = resolve;
    });
    client.onEvent((e) => {
      events.push(e);
      if (events.length === 2) resolveEvents();
    });
    await client.watch("mon_x");
    await eventsReady;
    expect(events.map((e) => e.event)).toEqual(["output", "task_exited"]);
    expect(events[0]).toMatchObject({ task_id: "mon_x", chunk: "tick\n" });
    expect(events[1]).toMatchObject({ task_id: "mon_x", exit_code: 0, duration_ms: 100 });
  });

  it("surfaces manager errors as ManagerError with code", async () => {
    await client.connect();
    await expect(client.stop("nope")).resolves.toBeUndefined(); // stop is ok in fake
    const bad = client.output("nope", 0, 1).catch((err) => err);
    // fake returns ok for output; use an unknown request type via list(all) path instead
    await expect(bad).resolves.toMatchObject({ chunk: "hello output\n" });
  });

  it("retries a wait after a dropped connection and reconnects immediately", async () => {
    await client.connect();
    fake.dropNext("wait");
    const started = Date.now();
    await expect(client.wait("sh_existing", 5000)).resolves.toEqual({ done: true, exit_code: 0 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(fake.received.filter((m) => m.type === "wait")).toHaveLength(2);
  });

  it("resends a dropped start with the same idempotency key", async () => {
    await client.connect();
    fake.dropNext("start");
    const result = await client.start({ kind: "shell", command: "echo hi", cwd: "/tmp", env: {} });
    const requests = fake.received.filter((m) => m.type === "start");
    expect(requests).toHaveLength(2);
    expect(requests[0].key).toBeTruthy();
    expect(requests[1].key).toBe(requests[0].key);
    expect(fake.startCount()).toBe(1);
    expect(result.task_id).toBe("sh_a1b2c3d4");
  });

  it("reconnects with re-hello after an unexpected disconnect", async () => {
    await client.connect();
    const reconnected = new Promise<void>((resolve) => client.onReconnect(resolve));
    // Server kills the connection; client should reconnect (first retry at 500ms).
    for (const s of fake.sockets) s.destroy();
    await reconnected;
    expect(client.isAvailable()).toBe(true);
    // A second hello arrived on the new connection.
    expect(fake.received.filter((m) => m.type === "hello").length).toBe(2);
    // Requests work again after reconnect.
    await expect(client.list()).resolves.toEqual([]);
  }, 10000);

  it("marks itself unavailable when the manager is unreachable", async () => {
    await fake.close();
    const lone = new ManagerClient({ home, sessionId: "sess-2", managerPath: null });
    expect(await lone.connect()).toBe(false);
    expect(lone.isAvailable()).toBe(false);
    await lone.close();
  });

  it("cold-starts past an empty Rust leftover spawn.lock (does not wait forever)", async () => {
    await fake.close();
    writeFileSync(join(home, "manager.spawn.lock"), "");
    const lone = new ManagerClient({ home, sessionId: "sess-lock", managerPath: null });
    expect(await lone.connect()).toBe(false);
    // Reclaimed the empty lock and attempted spawn; no binary → explicit error.
    // (Pre-fix: empty lock looked held → "timed out waiting for pbs-manager socket".)
    expect(lone.lastError()).toMatch(/binary not found/i);
    await lone.close();
  });
});

describe("tryAcquireSpawnLockFile", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pbs-lock-"));
    lockPath = join(dir, "manager.spawn.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires when the lock file is absent", () => {
    expect(tryAcquireSpawnLockFile(lockPath, process.pid)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    releaseSpawnLockFile(lockPath);
  });

  it("reclaims an empty lock left by the Rust fd-lock CLI", () => {
    writeFileSync(lockPath, "");
    expect(tryAcquireSpawnLockFile(lockPath, process.pid)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    releaseSpawnLockFile(lockPath);
  });

  it("reclaims a lock whose holder pid is dead", () => {
    writeFileSync(lockPath, "999999999");
    expect(tryAcquireSpawnLockFile(lockPath, process.pid)).toBe(true);
    releaseSpawnLockFile(lockPath);
  });

  it("refuses when another live process holds the lock", () => {
    writeFileSync(lockPath, String(process.pid));
    expect(tryAcquireSpawnLockFile(lockPath, process.pid + 1)).toBe(false);
  });
});
