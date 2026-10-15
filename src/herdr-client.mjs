import net from "node:net";

export class HerdrError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HerdrError";
    this.code = code;
  }
}

let nextId = 0;

// One request per connection: herdr answers each newline-delimited JSON request with one line.
export function request(socketPath, method, params, { timeoutMs = 3000 } = {}) {
  const id = `collapse-agents:${process.pid}:${++nextId}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const settle = (finish, value) => {
      clearTimeout(deadline);
      socket.destroy();
      finish(value);
    };
    // An absolute deadline, not socket.setTimeout: a peer trickling bytes must not hold us forever.
    const deadline = setTimeout(
      () => settle(reject, new Error(`herdr did not answer ${method} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    let buffer = "";
    socket.setEncoding("utf8"); // decodes multibyte glyphs split across reads
    socket.on("error", (error) => settle(reject, error));
    socket.on("close", () => settle(reject, new Error(`herdr closed the connection before answering ${method}`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        settle(reject, error);
        return;
      }
      if (response.error) settle(reject, new HerdrError(response.error.code, response.error.message));
      else settle(resolve, response.result);
    });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
