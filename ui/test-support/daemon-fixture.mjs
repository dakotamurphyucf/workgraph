import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function fixtureBinary() {
  return process.env.WORKGRAPH_TEST_BINARY ?? path.join(repository, "_build/default/bin/main.exe");
}

async function seed(call, root) {
  let serial = 0;
  const write = (method, params) =>
    call(
      method,
      JSON.stringify({
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: `seed-${++serial}`,
        ...params,
      }),
    );
  await write("workspace.create", {
    name: "Synthetic UI qualification",
    root: path.join(root, "workspace"),
  });
  await write("project.create", {
    project_id: "release",
    title: "Synthetic delivery workflow",
    description: "Isolated UI test data; never a user workspace.",
  });
  for (const [ticket_id, title] of [
    ["design", "Clarify the workflow and ownership rules"],
    ["build", "Implement the interface — Unicode title with clear scope"],
    ["review", "Review the exact implementation and browser evidence"],
  ]) {
    await write("ticket.create", {
      ticket_id,
      project_id: "release",
      title,
      description:
        "## Acceptance\n\n- Preserve exact inputs\n- Record verifiable evidence\n\n```ocaml\nlet value = 42\n```",
    });
  }
  await write("dependency.add", { ticket_id: "build", prerequisite_id: "design" });
  await write("dependency.add", { ticket_id: "review", prerequisite_id: "build" });
  // Deliberately construct this literal as text: JS numbers cannot represent it exactly.
  await call(
    "fact.put",
    '{"workspace_id":"demo","actor_id":"fixture-author","mutation_id":"exact-fact","scope":{"kind":"project","id":"release"},"key":"fixture.settings","expected_revision":"0","value":{"exact":9007199254740993,"negative_zero":-0,"exponent":1e99,"unicode":"雪","nullable":null}}',
  );
  await write("resource.put_text", {
    resource_id: "notes",
    expected_revision: "0",
    title: "Implementation notes",
    filename: "notes.md",
    mime_type: "text/markdown",
    text: "# Synthetic notes\n\n```ocaml\nlet answer = 42\n```\n\n<script>never_execute()</script>",
  });
  await write("resource.link", {
    resource_id: "notes",
    expected_revision: "1",
    target: { kind: "project", id: "release" },
  });
  await write("board.put", {
    board_id: "team",
    expected_revision: "0",
    scope: { kind: "project", id: "release" },
    title: "Team discussion",
  });
  await write("thread.put", {
    thread_id: "planning",
    expected_revision: "0",
    board_id: "team",
    title: "Implementation discussion",
    participants: ["fixture-author", "human"],
    mentions: [],
    links: [{ kind: "ticket", id: "build" }],
    state: "open",
    pinned: false,
  });
  await write("thread.reply", {
    thread_id: "planning",
    expected_revision: "1",
    body: "Synthetic discussion content for browser qualification.",
  });
  await write("session.create", {
    session_id: "generic",
    title: "Generic event stream, no agent schema",
    scopes: [{ kind: "project", id: "release" }],
  });
  const body = '{"measurement":9007199254740993,"description":"arbitrary event, not chat"}';
  await write("session.append", {
    session_id: "generic",
    events: [
      {
        client_id: "sensor-1",
        kind: "measurement",
        phase: "recorded",
        role: "sensor",
        payload: { kind: "inline", bytes_base64: Buffer.from(body).toString("base64") },
      },
    ],
  });
}

export async function startDaemonFixture({
  binary,
  seed: seedWorkspace = true,
  startupTimeoutMs = 10_000,
}) {
  if (!path.isAbsolute(binary))
    throw new Error("Fixture binary must be an absolute executable path.");
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 60_000)
    throw new Error("Fixture startup timeout must be 1..60000 milliseconds.");
  await access(binary, constants.X_OK);
  // Short path is intentional: sockaddr_un paths are tightly bounded on macOS.
  const root = await mkdtemp("/tmp/wgui-");
  const socket = path.join(root, "s");
  let log = "";
  let exited = false;
  let startupError = null;
  const startedAt = new Date().toISOString();
  let disposeStartedAt = null;
  let exit = null;
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  const daemon = spawn(binary, ["serve", path.join(root, "registry"), socket], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [daemon.stdout, daemon.stderr])
    stream.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-64 * 1024);
    });
  daemon.stdout.on("data", (chunk) => {
    stdoutTail = Buffer.concat([stdoutTail, chunk]).subarray(-65536);
  });
  daemon.stderr.on("data", (chunk) => {
    stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-65536);
  });
  const closed = new Promise((resolve) => {
    daemon.once("error", (error) => {
      startupError = error;
    });
    daemon.once("close", (code, signal) => {
      exited = true;
      exit = Object.freeze({ at: new Date().toISOString(), code, signal });
      resolve({ code, signal });
    });
  });
  let cleanup = null;
  const dispose = () => {
    if (cleanup) return cleanup;
    disposeStartedAt = new Date().toISOString();
    cleanup = (async () => {
      if (!exited) {
        daemon.kill("SIGTERM");
        if (!(await Promise.race([closed.then(() => true), delay(3000, false, { ref: false })]))) {
          daemon.kill("SIGKILL");
          if (!(await Promise.race([closed.then(() => true), delay(5000, false, { ref: false })])))
            throw new Error(`Fixture child did not stop; retained private root ${root}`);
        }
      }
      await rm(root, { recursive: true, force: true });
    })();
    return cleanup;
  };
  async function invoke(method, paramsJson, timeout = 15_000) {
    if (exited) throw new Error(`Fixture daemon is stopped. ${log}`);
    try {
      const result = await execute(binary, ["call", socket, method, paramsJson], {
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      });
      return result.stdout;
    } catch (error) {
      throw new Error(`Fixture ${method} failed: ${error.stdout ?? ""}${error.stderr ?? ""}`, {
        cause: error,
      });
    }
  }
  try {
    const deadline = performance.now() + startupTimeoutMs;
    let lastError = null;
    for (;;) {
      if (startupError) throw startupError;
      if (exited || performance.now() >= deadline)
        throw new Error(`Fixture daemon failed readiness. ${log}`, { cause: lastError });
      try {
        await invoke(
          "daemon.health",
          "{}",
          Math.max(1, Math.min(500, deadline - performance.now()) | 0),
        );
        break;
      } catch (error) {
        lastError = error;
        await delay(20);
      }
    }
    const call = (method, paramsJson) => invoke(method, paramsJson);
    if (seedWorkspace) await seed(call, root);
    if (daemon.pid === undefined) throw new Error("Fixture daemon has no owned PID.");
    return Object.freeze({
      root,
      socket,
      binary,
      pid: daemon.pid,
      workspace: "demo",
      project: "release",
      actor: "fixture-author",
      call,
      diagnostics: () =>
        Object.freeze({
          capturedAt: new Date().toISOString(),
          startedAt,
          disposeStartedAt,
          exit,
          stdoutTail: stdoutTail.toString("utf8"),
          stderrTail: stderrTail.toString("utf8"),
        }),
      dispose,
    });
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Fixture startup and cleanup both failed.");
    }
    throw error;
  }
}
