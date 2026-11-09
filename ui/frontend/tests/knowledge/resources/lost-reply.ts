import { createConnection, createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
/** Test-only exact frame transport. It drops one complete committed upstream
 * response; it never alters a native request or injects a daemon result. */
export async function lostReplyProxy(root: string, socket: string) {
  const path = join(root, "resource-lost-reply"),
    connections = new Set<Socket>(),
    failures: string[] = [],
    methods: { method: string; sha256: string }[] = [],
    lost: { method: string; request: string; response: string }[] = [];
  let armed: string | null = null;
  let target = socket;
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const server = createServer((client) => {
    const upstream = createConnection(target);
    connections.add(client);
    connections.add(upstream);
    let request = Buffer.alloc(0),
      response = Buffer.alloc(0),
      drop = false,
      requestHash = "",
      method = "",
      parsed = false;
    for (const conn of [client, upstream]) {
      conn.on("close", () => connections.delete(conn));
      conn.on("error", (error) => {
        failures.push(error.message);
        client.destroy();
        upstream.destroy();
      });
    }
    client.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      if (parsed) return;
      request = Buffer.concat([request, chunk]);
      if (request.length < 4) return;
      const length = request.readUInt32BE(0);
      if (length > 4194304) {
        failures.push("Oversized request frame");
        client.destroy();
        upstream.destroy();
        return;
      }
      if (request.length < 4 + length) return;
      parsed = true;
      const decoded: unknown = JSON.parse(request.subarray(4, 4 + length).toString("utf8"));
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("method" in decoded) ||
        typeof decoded.method !== "string"
      ) {
        failures.push("Invalid test request");
        return;
      }
      method = decoded.method;
      requestHash = hash(request.subarray(0, 4 + length));
      methods.push({ method, sha256: requestHash });
      if (method === armed) {
        armed = null;
        drop = true;
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!drop) {
        client.write(chunk);
        return;
      }
      response = Buffer.concat([response, chunk]);
      if (response.length < 4) return;
      const length = response.readUInt32BE(0);
      if (length > 16777216) {
        failures.push("Oversized response frame");
        client.destroy();
        upstream.destroy();
        return;
      }
      if (response.length >= 4 + length) {
        lost.push({
          method,
          request: requestHash,
          response: hash(response.subarray(0, 4 + length)),
        });
        client.end();
        upstream.end();
      }
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socket: path,
    methods,
    lost,
    failures,
    idle: () => connections.size === 0,
    arm: (method: string) => {
      armed = method;
    },
    retarget: (nextSocket: string) => {
      if (connections.size !== 0) throw new Error("Retarget requires no active test proxy clients");
      target = nextSocket;
    },
    dispose: async () => {
      for (const conn of connections) conn.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
