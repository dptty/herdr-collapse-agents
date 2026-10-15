import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stands in for herdr's socket: answers each newline-delimited JSON request with one line.
export async function startFakeHerdr(handler) {
  const dir = await mkdtemp(join(tmpdir(), "ca-"));
  const socketPath = join(dir, "herdr.sock");
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push({ method: message.method, params: message.params });
        const reply = await handler(message.method, message.params);
        if (reply === undefined || socket.destroyed) continue;
        const body = reply.error ? { id: message.id, error: reply.error } : { id: message.id, result: reply };
        socket.write(JSON.stringify(body) + "\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
