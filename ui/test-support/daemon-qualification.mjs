// Owned executable integration control. Usage: node daemon-qualification.mjs UI CORE OLD_CORE
// No test application or synthetic daemon responses: the proxy forwards exact native
// frames, switches only between two owned daemons, and drops one committed reply.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemonFixture } from "./daemon-fixture.mjs";
import { startCompanionFixture } from "./companion-fixture.mjs";

const [ui, core, oldCore] = process.argv.slice(2).map((value) => path.resolve(value));
assert(ui && core && oldCore, "three explicit executable paths required");
const pins = await Promise.all(
  [ui, core, oldCore].map(async (file) => ({
    path: file,
    sha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  })),
);
const owned = [];
let server;
const peers = new Set();
let proxyRoot;
let checks = 0;
const check = (condition, message) => {
  assert(condition, message);
  checks++;
};
try {
  const current = await startDaemonFixture({ binary: core });
  owned.push(current);
  const old = await startDaemonFixture({ binary: oldCore, seed: false });
  owned.push(old);
  const currentInit = JSON.parse(await current.call("initialize", "{}"));
  const oldInit = JSON.parse(await old.call("initialize", "{}"));
  check(currentInit.result.data.version === "0.8.1", "actual current package0.8.1");
  check(oldInit.result.data.version === "0.7.0", "actual old package0.7.0");
  check(
    currentInit.result.data.workgraph_api === "0.7" && oldInit.result.data.workgraph_api === "0.7",
    "same API profile does not establish package compatibility",
  );
  let backend = old.socket;
  let drop = true;
  const semantic = [];
  const writes = [];
  proxyRoot = await mkdtemp("/tmp/wg-qual-");
  const socket = path.join(proxyRoot, "s");
  const proxyFailures = [];
  const failProxy = (error) => proxyFailures.push(error);
  const track = (stream) => {
    peers.add(stream);
    stream.on("close", () => peers.delete(stream));
    stream.on("error", () => {});
    return stream;
  };
  function frameFrom(stream) {
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      let expected = null;
      const timer = setTimeout(() => finish(new Error("native frame deadline")), 10_000);
      const cleanup = () => {
        clearTimeout(timer);
        stream.off("data", data);
        stream.off("end", truncated);
        stream.off("close", truncated);
        stream.off("error", finish);
      };
      const finish = (error) => {
        cleanup();
        reject(error);
      };
      const truncated = () => finish(new Error("truncated native frame"));
      function data(chunk) {
        if (bytes.length + chunk.length > 4 + 4 * 1024 * 1024)
          return finish(new Error("native frame exceeds bound"));
        bytes = Buffer.concat([bytes, chunk]);
        if (expected === null && bytes.length >= 4) {
          const size = bytes.readUInt32BE(0);
          if (size === 0 || size > 4 * 1024 * 1024)
            return finish(new Error("invalid native frame length"));
          expected = 4 + size;
        }
        if (expected === null || bytes.length < expected) return;
        if (bytes.length !== expected) return finish(new Error("trailing native frame bytes"));
        cleanup();
        // One native frame per connection; a later second frame is a fixture failure.
        stream.on("data", () => {
          failProxy(new Error("trailing native frame"));
          stream.destroy();
        });
        resolve(bytes);
      }
      stream.on("data", data);
      stream.once("end", truncated);
      stream.once("close", truncated);
      stream.once("error", finish);
    });
  }
  server = net.createServer((incoming) => {
    const peer = track(incoming);
    let upstream;
    const forward = async () => {
      const frame = await frameFrom(peer);
      const request = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4)),
      );
      if (request.method !== "initialize") semantic.push(request.method);
      const write = request.method === "ticket.create";
      if (write) writes.push(frame);
      upstream = track(net.createConnection(backend));
      peer.once("close", () => upstream.destroy());
      const response = frameFrom(upstream);
      upstream.write(frame);
      const result = await response;
      // Decode actual native JSON before forwarding/dropping; failures are awaited
      // fixture errors, never exceptions escaping an event callback.
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.subarray(4)));
      if (write && drop) {
        drop = false;
        peer.destroy();
      } else peer.end(result);
      upstream.destroy();
    };
    forward().catch((error) => {
      failProxy(error);
      peer.destroy();
      upstream?.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  const companion = await startCompanionFixture({ binary: ui });
  owned.push(companion);
  const html = await (await fetch(companion.url)).text();
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  assert(capability, "actual embedded bootstrap capability");
  async function call(method, route, body) {
    const response = await fetch(new URL(`/ui-api/v1${route}`, companion.url), {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        "X-Workgraph-UI-Capability": capability,
        ...(body === undefined
          ? {}
          : { Origin: new URL(companion.url).origin, "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (proxyFailures.length) throw new AggregateError(proxyFailures, "native proxy failed");
    return { status: response.status, ...value };
  }
  function success(result) {
    assert(result.ok, JSON.stringify(result));
    return result.data;
  }
  const profile = success(
    await call("POST", "/connections", { id: "qualified", label: "Owned qualification", socket }),
  );
  const invocation = { connection_id: profile.id, generation: profile.generation };
  const draft = {
    ...invocation,
    intention_id: "real-exact-retry",
    context: {
      workspace_id: "demo",
      project_id: "release",
      writer: { actor_id: "fixture-author", run_id: null },
    },
    method: "ticket.create",
    params: {
      workspace_id: "demo",
      actor_id: "fixture-author",
      ticket_id: "qualification-write",
      project_id: "release",
      title: "Exact original writer",
    },
  };
  let rejected = await call("POST", "/read", {
    ...invocation,
    method: "workspace.list",
    params: {},
    lane: "visible",
  });
  check(
    !rejected.ok && rejected.error.kind === "Unsupported_version",
    "actual0.7 ordinary read rejected",
  );
  rejected = await call("POST", "/operations/prepare", draft);
  check(
    !rejected.ok && rejected.error.kind === "Unsupported_version",
    "actual0.7 new preparation rejected",
  );
  check(semantic.length === 0, "old package emitted no semantic requests");
  check(
    success(await call("GET", "/connections")).items.length === 1,
    "local profiles remain usable",
  );
  backend = current.socket;
  success(await call("POST", "/read", { ...invocation, method: "workspace.list", params: {} }));
  const prepared = success(await call("POST", "/operations/prepare", draft));
  check(prepared.state.kind === "prepared_unsent", "actual matching package prepares");
  const operationPath = `/operations/${prepared.operation_id}`;
  success(await call("POST", `${operationPath}/execute`, {}));
  async function settled() {
    const deadline = performance.now() + 10_000;
    do {
      const operation = success(await call("GET", operationPath));
      if (operation.state.kind !== "sending") return operation;
      await delay(10);
    } while (performance.now() < deadline);
    throw new Error("owned operation did not settle");
  }
  const unknown = await settled();
  check(
    unknown.state.kind === "outcome_unknown",
    "dropped actual committed response stays unknown",
  );
  const native = JSON.parse(
    await current.call("ticket.get", '{"workspace_id":"demo","ticket_id":"qualification-write"}'),
  );
  check(
    native.result.data.ticket.title === "Exact original writer",
    "independent actual native commit readback",
  );
  const count = semantic.length;
  backend = old.socket;
  for (const action of ["retry", "recover"]) {
    rejected = await call("POST", `${operationPath}/${action}`, {});
    check(
      !rejected.ok && rejected.error.kind === "Unsupported_version",
      `old package blocks ${action}`,
    );
    check(
      JSON.stringify(success(await call("GET", operationPath))) === JSON.stringify(unknown),
      `${action} preserves full original unknown observation`,
    );
  }
  check(
    semantic.length === count && writes.length === 1,
    "failed qualification emits no retry or receipt exchange",
  );
  backend = current.socket;
  success(await call("POST", `${operationPath}/retry`, {}));
  check(
    (await settled()).state.kind === "committed",
    "restored matching package exact retry commits",
  );
  check(
    writes.length === 2 && writes[0].equals(writes[1]),
    "actual retry preserves exact full native request bytes",
  );
  console.log(
    JSON.stringify(
      {
        checks,
        pins,
        current_initialize: currentInit.result.data,
        old_initialize: oldInit.result.data,
        semantic_requests: semantic,
        exact_request_sha256: createHash("sha256").update(writes[0]).digest("hex"),
      },
      null,
      2,
    ),
  );
} finally {
  const errors = [];
  for (const peer of peers) peer.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const fixture of owned.reverse())
    try {
      await fixture.dispose();
    } catch (error) {
      errors.push(error);
    }
  if (proxyRoot) await rm(proxyRoot, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "owned fixture cleanup failed");
}
