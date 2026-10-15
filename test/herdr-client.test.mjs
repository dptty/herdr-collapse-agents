import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, request } from "../src/herdr-client.mjs";
import { startFakeHerdr } from "./fake-herdr.mjs";

async function rawServer(t, onConnection) {
  const dir = await mkdtemp(join(tmpdir(), "ca-"));
  const socketPath = join(dir, "raw.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}

test("request sends method and params and resolves the result", async (t) => {
  const herdr = await startFakeHerdr(() => ({ type: "agent_list", agents: [] }));
  t.after(() => herdr.close());
  assert.deepEqual(await request(herdr.socketPath, "agent.list", {}), { type: "agent_list", agents: [] });
  assert.deepEqual(herdr.requests, [{ method: "agent.list", params: {} }]);
});

test("an error response rejects with herdr's code", async (t) => {
  const herdr = await startFakeHerdr(() => ({ error: { code: "plugin_not_found", message: "plugin not found" } }));
  t.after(() => herdr.close());
  await assert.rejects(request(herdr.socketPath, "agent.view.set", {}), (error) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "plugin_not_found");
    assert.equal(error.message, "plugin_not_found: plugin not found");
    return true;
  });
});

test("a herdr that never answers times out", async (t) => {
  const herdr = await startFakeHerdr(() => undefined);
  t.after(() => herdr.close());
  await assert.rejects(request(herdr.socketPath, "agent.list", {}, { timeoutMs: 100 }), /did not answer agent\.list/);
});

test("a herdr that trickles bytes without finishing still times out", { timeout: 2000 }, async (t) => {
  const socketPath = await rawServer(t, (socket) => {
    const interval = setInterval(() => socket.write(" "), 20);
    socket.on("close", () => clearInterval(interval));
  });
  const started = Date.now();
  await assert.rejects(request(socketPath, "agent.list", {}, { timeoutMs: 150 }), /did not answer agent\.list/);
  assert.ok(Date.now() - started < 1000);
});

test("a missing socket rejects", async () => {
  await assert.rejects(request("/nonexistent/herdr.sock", "agent.list", {}), /ENOENT/);
});

test("a glyph split across socket reads decodes intact", async (t) => {
  const reply = Buffer.from(JSON.stringify({ id: "x", result: { label: "✓1" } }) + "\n");
  const cut = reply.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte ✓
  const socketPath = await rawServer(t, (socket) => {
    socket.once("data", async () => {
      socket.write(reply.subarray(0, cut));
      await new Promise((resolve) => setTimeout(resolve, 20));
      socket.end(reply.subarray(cut));
    });
  });
  assert.deepEqual(await request(socketPath, "agent.view.set", {}), { label: "✓1" });
});
