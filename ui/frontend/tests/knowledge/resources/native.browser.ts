import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startDaemonFixture, fixtureBinary } from "../../../../test-support/daemon-fixture.mjs";
import {
  startCompanionFixture,
  companionBinary,
} from "../../../../test-support/companion-fixture.mjs";
import { lostReplyProxy } from "./lost-reply";
import { persistentCompanion } from "./persistent-companion";
import {
  uploadJobCodec,
  stagePageCodec,
} from "../../../src/features/knowledge/resources/upload-codecs";
import { json, decode } from "../../work/actions-fixtures";
import { createResourceUploadController } from "../../../src/features/knowledge/resources/upload-controller";
import { createHttpClient } from "../../../src/core/protocol/http";
import * as d from "../../../src/core/protocol/decoders";
import { createTestProcessor } from "../../core/processing-harness";
import { setTimeout as delay } from "node:timers/promises";

type ObjectValue = Readonly<Record<string, unknown>>;
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected bounded native test object");
  return value as ObjectValue;
}
function field(value: unknown, name: string): unknown {
  const result = object(value)[name];
  if (result === undefined) throw new Error(`Missing native field ${name}`);
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected native string");
  return value;
}
function success(value: unknown): unknown {
  if (field(value, "ok") !== true) throw new Error(JSON.stringify(value));
  return field(value, "data");
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function http(companion: { readonly url: string }) {
  const html = await (await fetch(companion.url)).text();
  const capability = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
  if (!capability) throw new Error("Actual embedded capability absent");
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(new URL(`/ui-api/v1${path}`, companion.url), {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "X-Workgraph-UI-Capability": capability,
        ...(body === undefined
          ? {}
          : { Origin: new URL(companion.url).origin, "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
    return success(value);
  };
}
async function settled(call: Awaited<ReturnType<typeof http>>, id: string) {
  const deadline = performance.now() + 15_000;
  do {
    const value = await call("GET", `/resource-uploads/${id}`);
    expect(uploadJobCodec.decode(json(value)).ok, JSON.stringify(value)).toBe(true);
    if (text(field(field(value, "phase"), "kind")) !== "running") return value;
    await delay(10);
  } while (performance.now() < deadline);
  throw new Error("Native Resource helper did not settle");
}
async function upload(
  call: Awaited<ReturnType<typeof http>>,
  profile: unknown,
  id: string,
  revision: string,
  bytes: Buffer,
  resourceId = "binary-artifact",
  start = true,
) {
  const stage = `${id}-source`;
  await call("POST", "/resource-stages/prepare", {
    stage_id: stage,
    digest: digest(bytes),
    size_bytes: String(bytes.byteLength),
  });
  for (let offset = 0; offset < bytes.byteLength; offset += 262144)
    await call("POST", `/resource-stages/${stage}/chunks`, {
      offset: String(offset),
      data_base64: bytes.subarray(offset, offset + 262144).toString("base64"),
    });
  await call("POST", `/resource-stages/${stage}/seal`, {});
  const stages = await call("GET", "/resource-stages?offset=0&limit=100");
  const decodedStages = stagePageCodec.decode(json(stages));
  expect(decodedStages.ok, JSON.stringify(decodedStages)).toBe(true);
  const prepared = await call("POST", "/resource-uploads/prepare", {
    stage_id: stage,
    preparation: {
      intention_id: id,
      connection_id: field(profile, "id"),
      generation: field(profile, "generation"),
      context: {
        workspace_id: "demo",
        project_id: "release",
        writer: { actor_id: "fixture-author", run_id: null },
      },
      method: "resource.upload",
      params: {
        workspace_id: "demo",
        actor_id: "fixture-author",
        resource_id: resourceId,
        expected_revision: revision,
        title: "Synthetic artifact",
        filename: "artifact.bin",
        mime_type: "application/octet-stream",
        ticket_id: "resource-target",
      },
    },
  });
  expect(field(field(prepared, "phase"), "kind")).toBe("prepared_unsent");
  if (start) await call("POST", `/resource-uploads/${id}/start`, {});
  return { job: start ? await settled(call, id) : prepared, stage };
}
function published(job: unknown, link: "committed" | "unresolved" = "committed") {
  const phase = field(job, "phase");
  expect(field(phase, "kind")).toBe("published");
  expect(field(field(phase, "link"), "kind"), JSON.stringify(phase)).toBe(link);
  return field(field(phase, "publication"), "data");
}

test("native Resource helper publishes new and existing binary versions with distinct metadata guards", async ({
  browserName,
}, info) => {
  const daemon = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    const companion = await startCompanionFixture({ binary: companionBinary() });
    try {
      await info.attach("actual-native-pair.json", {
        body: JSON.stringify({
          core: { path: daemon.binary, sha256: digest(await readFile(daemon.binary)) },
          ui: { path: companion.binary, sha256: companion.binarySha256 },
          assetManifest: companion.ready.asset_manifest_sha256,
          runnerProject: browserName,
          kind: "native executable control; no browser page",
        }),
        contentType: "application/json",
      });
      const call = await http(companion);
      const profile = await call("POST", "/connections", {
        id: "resource-native",
        label: "Synthetic Resource",
        socket: daemon.socket,
      });
      const rpc = async (method: string, params: unknown) => {
        const value: unknown = JSON.parse(await daemon.call(method, JSON.stringify(params)));
        const result = field(value, "result");
        return field(result, "data");
      };
      await rpc("ticket.create", {
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: "resource-ticket",
        ticket_id: "resource-target",
        project_id: "release",
        title: "Resource target",
      });
      const firstBytes = Buffer.from([0, 255, 17, 128]);
      const first = await upload(call, profile, "first-binary", "0", firstBytes);
      const firstPublication = published(first.job);
      expect(field(firstPublication, "revision")).toBe("1");
      expect(field(field(firstPublication, "version"), "revision")).toBe("1");
      expect(field(field(firstPublication, "version"), "digest")).toBe(digest(firstBytes));
      expect(field(await call("GET", `/resource-stages/${first.stage}`), "source_retained")).toBe(
        false,
      );
      // Linking is a second native mutation. Subsequent metadata edit makes its
      // guard independent from the retained content-version ordinal.
      await rpc("resource.update", {
        workspace_id: "demo",
        actor_id: "fixture-author",
        mutation_id: "resource-title",
        resource_id: "binary-artifact",
        expected_revision: "2",
        title: "Updated title",
      });
      const secondBytes = Buffer.alloc(262145, 137);
      const second = await upload(call, profile, "second-binary", "3", secondBytes);
      // The first upload already linked this ticket. Native rejects duplicate
      // linking; the durable second publication remains independently successful.
      const secondPublication = published(second.job, "unresolved");
      expect(field(field(field(field(second.job, "phase"), "link"), "problem"), "kind")).toBe(
        "Conflict",
      );
      expect(field(secondPublication, "revision")).toBe("4");
      expect(field(field(secondPublication, "version"), "revision")).toBe("2");
      expect(field(field(secondPublication, "version"), "digest")).toBe(digest(secondBytes));
      expect(field(await call("GET", `/resource-stages/${second.stage}`), "source_retained")).toBe(
        false,
      );
      const retained = await rpc("resource.get", {
        workspace_id: "demo",
        resource_id: "binary-artifact",
      });
      expect(field(retained, "revision")).toBe("4");
      expect(field(field(retained, "current_version"), "revision")).toBe("2");
      // Exact retry of unresolved linking is receipt-first after source cleanup;
      // it cannot manufacture a third publication or refresh the saved guard.
      await call("POST", "/resource-uploads/second-binary/retry-exact", {});
      const again = await settled(call, "second-binary");
      expect(field(again, "native_plan")).toEqual(field(second.job, "native_plan"));
      expect(field(field(again, "phase"), "kind")).toBe("published");
      const afterRetry = await rpc("resource.get", {
        workspace_id: "demo",
        resource_id: "binary-artifact",
      });
      expect(field(afterRetry, "revision")).toBe("4");
      expect(field(field(afterRetry, "current_version"), "revision")).toBe("2");
      expect(field(field(afterRetry, "current_version"), "digest")).toBe(digest(secondBytes));
    } finally {
      const before = companion.diagnostics();
      try {
        await companion.dispose();
      } finally {
        await info.attach("companion-process.json", {
          body: JSON.stringify({ before, after: companion.diagnostics() }),
          contentType: "application/json",
        });
      }
    }
  } finally {
    const before = daemon.diagnostics();
    try {
      await daemon.dispose();
    } finally {
      await info.attach("daemon-process.json", {
        body: JSON.stringify({ before, after: daemon.diagnostics() }),
        contentType: "application/json",
      });
    }
  }
});

test("lost native finish and link replies recover exact receipts after companion restart without source replay", async ({
  browserName,
}, info) => {
  test.setTimeout(60000);
  const daemon = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    const proxy = await lostReplyProxy(daemon.root, daemon.socket);
    try {
      const companion = await persistentCompanion(companionBinary());
      try {
        await info.attach("pair.json", {
          body: JSON.stringify({
            core: digest(await readFile(daemon.binary)),
            ui: digest(await readFile(companionBinary())),
            kind: "native executable restart control; no browser page",
            runnerProject: browserName,
          }),
          contentType: "application/json",
        });
        let call = await http(companion);
        const profile = await call("POST", "/connections", {
          id: "resource-recovery",
          label: "Synthetic receipt recovery",
          socket: proxy.socket,
        });
        await daemon.call(
          "ticket.create",
          JSON.stringify({
            workspace_id: "demo",
            actor_id: "fixture-author",
            mutation_id: "recovery-ticket",
            ticket_id: "resource-target",
            project_id: "release",
            title: "Recovery target",
          }),
        );
        for (const [name, method] of [
          ["finish", "resource.finish_upload"],
          ["link", "resource.link"],
        ] as const) {
          proxy.arm(method);
          const bytes = Buffer.from(`synthetic ${name} publication`),
            resourceId = `lost-${name}`;
          const result = await upload(call, profile, `lost-${name}-upload`, "0", bytes, resourceId);
          const initialKind = text(field(field(result.job, "phase"), "kind"));
          expect(initialKind).toBe(name === "finish" ? "outcome_unknown" : "published");
          if (name === "link")
            expect(field(field(field(result.job, "phase"), "link"), "kind")).toBe("unresolved");
          expect(proxy.lost.at(-1)?.method).toBe(method);
          await companion.restart();
          call = await http(companion);
          const before = await call("GET", `/resource-uploads/lost-${name}-upload`);
          expect(field(before, "native_plan")).toEqual(field(result.job, "native_plan"));
          const semanticBefore = proxy.methods.filter(
            (v) => v.method !== "initialize" && v.method !== "workspace.receipt",
          );
          await call("POST", `/resource-uploads/lost-${name}-upload/recover`, {});
          const recovered = await settled(call, `lost-${name}-upload`);
          const publication = published(recovered, name === "finish" ? "unresolved" : "committed");
          expect(field(field(publication, "version"), "digest")).toBe(digest(bytes));
          expect(
            proxy.methods.filter(
              (v) => v.method !== "initialize" && v.method !== "workspace.receipt",
            ),
          ).toEqual(semanticBefore);
          expect(
            field(await call("GET", `/resource-stages/${result.stage}`), "source_retained"),
          ).toBe(false);
          const native: unknown = JSON.parse(
            await daemon.call(
              "resource.get",
              JSON.stringify({ workspace_id: "demo", resource_id: resourceId }),
            ),
          );
          const captured = field(field(native, "result"), "data");
          expect(field(captured, "revision")).toBe(name === "finish" ? "1" : "2");
          expect(field(field(captured, "current_version"), "revision")).toBe("1");
          if (name === "finish") {
            const beforeRetry = proxy.methods.length;
            await call("POST", `/resource-uploads/lost-${name}-upload/retry-exact`, {});
            published(await settled(call, `lost-${name}-upload`));
            const writes = proxy.methods
              .slice(beforeRetry)
              .filter((v) => v.method !== "initialize" && v.method !== "workspace.receipt");
            expect(writes.map((v) => v.method)).toEqual([
              "resource.finish_upload",
              "resource.link",
            ]);
            expect(writes[0]?.sha256).toBe(
              proxy.lost.find((v) => v.method === "resource.finish_upload")?.request,
            );
          }
          await companion.restart();
          call = await http(companion);
          const replay = await call("GET", `/resource-uploads/lost-${name}-upload`);
          published(replay);
          expect(field(replay, "native_plan")).toEqual(field(result.job, "native_plan"));
        }
        expect(proxy.failures).toEqual([]);
        expect(proxy.lost).toHaveLength(2);
        await info.attach("exact-frame-evidence.json", {
          body: JSON.stringify({ lost: proxy.lost, requests: proxy.methods }),
          contentType: "application/json",
        });
      } finally {
        try {
          await companion.dispose();
        } finally {
          await info.attach("companion-processes.json", {
            body: JSON.stringify(companion.events),
            contentType: "application/json",
          });
        }
      }
    } finally {
      await proxy.dispose();
    }
  } finally {
    const before = daemon.diagnostics();
    try {
      await daemon.dispose();
    } finally {
      await info.attach("daemon-process.json", {
        body: JSON.stringify({ before, after: daemon.diagnostics() }),
        contentType: "application/json",
      });
    }
  }
});

test("local journal failure survives restart and inventory restores exact offline save without a browser source draft", async ({
  browserName,
}, info) => {
  const companion = await persistentCompanion(companionBinary());
  try {
    await info.attach("pair.json", {
      body: JSON.stringify({
        ui: digest(await readFile(companionBinary())),
        kind: "actual native local-save recovery with production controller/protocol transfer-loopback; no browser page",
        runnerProject: browserName,
      }),
      contentType: "application/json",
    });
    let call = await http(companion);
    const profile = await call("POST", "/connections", {
      id: "offline-resource",
      label: "Synthetic unavailable daemon",
      socket: "/tmp/synthetic-unavailable-resource.sock",
    });
    const bytes = Buffer.from("abc"),
      stage = "local-save-source",
      id = "local-save-upload";
    await call("POST", "/resource-stages/prepare", {
      stage_id: stage,
      digest: digest(bytes),
      size_bytes: "3",
    });
    await call("POST", `/resource-stages/${stage}/chunks`, {
      offset: "0",
      data_base64: bytes.toString("base64"),
    });
    await call("POST", `/resource-stages/${stage}/seal`, {});
    const preparation = {
      intention_id: id,
      connection_id: field(profile, "id"),
      generation: field(profile, "generation"),
      context: {
        workspace_id: "demo",
        project_id: null,
        writer: { actor_id: "fixture-author", run_id: null },
      },
      method: "resource.upload",
      params: {
        workspace_id: "demo",
        actor_id: "fixture-author",
        resource_id: "local-artifact",
        expected_revision: "0",
        title: "Synthetic offline artifact",
        filename: "artifact.bin",
        mime_type: "application/octet-stream",
      },
    };
    const restore = await companion.blockJournal();
    try {
      await expect(
        call("POST", "/resource-uploads/prepare", { stage_id: stage, preparation }),
      ).rejects.toThrow(/parent directory|directory/u);
    } finally {
      await restore();
    }
    await companion.restart();
    call = await http(companion);
    const retained = await call("GET", `/resource-uploads/${id}`);
    expect(field(field(retained, "phase"), "kind")).toBe("local_save_incomplete");
    const html = await (await fetch(companion.url)).text(),
      cap = /name="workgraph-capability" content="([a-f0-9]{64})"/u.exec(html)?.[1];
    if (!cap) throw new Error("Actual companion capability absent");
    const processing = createTestProcessor(),
      client = createHttpClient({
        origin: new URL(companion.url).origin,
        capability: cap,
        processing,
        // Node's fetch does not supply the Origin that browser POSTs send.
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          if (init?.method === "POST") headers.set("Origin", new URL(companion.url).origin);
          return fetch(input, { ...init, headers });
        },
      }),
      controller = createResourceUploadController(client);
    try {
      await controller.inventory();
      expect(controller.get().issue).toBeNull();
      expect(controller.get().drafts).toHaveLength(0);
      expect(controller.get().jobs?.items).toHaveLength(1);
      await controller.finishSaving(decode(d.identifier, id));
      expect(controller.get().issue).toBeNull();
      expect(controller.get().selectedJob?.phase.kind).toBe("prepared_unsent");
      expect(controller.get().selectedJob?.intention_id).toBe(id);
    } finally {
      controller.dispose();
      processing.dispose();
    }
    const saved = await call("GET", `/resource-uploads/${id}`);
    expect(field(saved, "native_plan")).toEqual(field(retained, "native_plan"));
    expect(field(saved, "saved_request")).toEqual(field(retained, "saved_request"));
    expect(field(saved, "journal_path")).toBe(field(retained, "journal_path"));
    expect(field(saved, "input_hash")).toBe(field(retained, "input_hash"));
    await companion.restart();
    call = await http(companion);
    expect(field(field(await call("GET", `/resource-uploads/${id}`), "phase"), "kind")).toBe(
      "prepared_unsent",
    );
  } finally {
    try {
      await companion.dispose();
    } finally {
      await info.attach("companion-processes.json", {
        body: JSON.stringify(companion.events),
        contentType: "application/json",
      });
    }
  }
});

// Playwright introspects fixture dependencies; this control owns native processes only.
// eslint-disable-next-line no-empty-pattern
test("Transfer start, retry and receipt-only recovery qualify the actual daemon package before semantic requests", async ({}, info) => {
  const legacyBinary = process.env.WORKGRAPH_UI_TEST_LEGACY_BINARY;
  test.skip(
    legacyBinary === undefined,
    "Explicit released0.7 daemon binary required for version-boundary control",
  );
  if (legacyBinary === undefined) throw new Error("Missing legacy qualification binary");
  const daemon = await startDaemonFixture({ binary: fixtureBinary() });
  try {
    const legacy = await startDaemonFixture({ binary: legacyBinary });
    try {
      const proxy = await lostReplyProxy(daemon.root, daemon.socket);
      try {
        const companion = await persistentCompanion(companionBinary());
        try {
          const call = await http(companion),
            profile = await call("POST", "/connections", {
              id: "versioned-transfer",
              label: "Synthetic package boundary",
              socket: proxy.socket,
            });
          await daemon.call(
            "ticket.create",
            JSON.stringify({
              workspace_id: "demo",
              actor_id: "fixture-author",
              mutation_id: "qualifier-ticket",
              ticket_id: "resource-target",
              title: "Synthetic qualification target",
            }),
          );
          const first = await upload(
            call,
            profile,
            "qualifier-start",
            "0",
            Buffer.from("first"),
            "qualifier-first",
            false,
          );
          await expect.poll(proxy.idle).toBe(true);
          proxy.retarget(legacy.socket);
          const beforeStart = proxy.methods.length;
          await expect(call("POST", "/resource-uploads/qualifier-start/start", {})).rejects.toThrow(
            /Unsupported_version/u,
          );
          expect(
            field(field(await call("GET", "/resource-uploads/qualifier-start"), "phase"), "kind"),
          ).toBe("prepared_unsent");
          expect(proxy.methods.slice(beforeStart).map((x) => x.method)).toEqual(["initialize"]);
          await expect.poll(proxy.idle).toBe(true);
          proxy.retarget(daemon.socket);
          await call("POST", "/resource-uploads/qualifier-start/start", {});
          published(await settled(call, "qualifier-start"));
          proxy.arm("resource.finish_upload");
          const unknown = await upload(
            call,
            profile,
            "qualifier-unknown",
            "0",
            Buffer.from("uncertain"),
            "qualifier-second",
          );
          expect(field(field(unknown.job, "phase"), "kind")).toBe("outcome_unknown");
          await expect.poll(proxy.idle).toBe(true);
          proxy.retarget(legacy.socket);
          for (const action of ["retry-exact", "recover"]) {
            const before = proxy.methods.length;
            await expect(
              call("POST", `/resource-uploads/qualifier-unknown/${action}`, {}),
            ).rejects.toThrow(/Unsupported_version/u);
            const retained = await call("GET", "/resource-uploads/qualifier-unknown");
            expect(field(retained, "phase")).toEqual(field(unknown.job, "phase"));
            expect(field(retained, "native_plan")).toEqual(field(unknown.job, "native_plan"));
            expect(field(retained, "saved_request")).toEqual(field(unknown.job, "saved_request"));
            expect(proxy.methods.slice(before).map((x) => x.method)).toEqual(["initialize"]);
          }
          await expect.poll(proxy.idle).toBe(true);
          proxy.retarget(daemon.socket);
          const beforeRecovery = proxy.methods.length;
          await call("POST", "/resource-uploads/qualifier-unknown/recover", {});
          published(await settled(call, "qualifier-unknown"), "unresolved");
          expect(
            proxy.methods
              .slice(beforeRecovery)
              .every((x) => x.method === "initialize" || x.method === "workspace.receipt"),
          ).toBe(true);
          expect(field(first.job, "input_hash")).toBe(
            field(await call("GET", "/resource-uploads/qualifier-start"), "input_hash"),
          );
          await info.attach("actual-package-boundary.json", {
            body: JSON.stringify({
              current: digest(await readFile(daemon.binary)),
              legacy: digest(await readFile(legacy.binary)),
              ui: digest(await readFile(companionBinary())),
              methods: proxy.methods,
              lost: proxy.lost,
            }),
            contentType: "application/json",
          });
          expect(proxy.failures).toEqual([]);
        } finally {
          try {
            await companion.dispose();
          } finally {
            await info.attach("companion-processes.json", {
              body: JSON.stringify(companion.events),
              contentType: "application/json",
            });
          }
        }
      } finally {
        await proxy.dispose();
      }
    } finally {
      const before = legacy.diagnostics();
      try {
        await legacy.dispose();
      } finally {
        await info.attach("legacy-process.json", {
          body: JSON.stringify({ before, after: legacy.diagnostics() }),
          contentType: "application/json",
        });
      }
    }
  } finally {
    const before = daemon.diagnostics();
    try {
      await daemon.dispose();
    } finally {
      await info.attach("current-process.json", {
        body: JSON.stringify({ before, after: daemon.diagnostics() }),
        contentType: "application/json",
      });
    }
  }
});
