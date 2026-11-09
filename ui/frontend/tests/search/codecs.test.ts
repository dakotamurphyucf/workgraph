import { describe, it, expect } from "vitest";
import {
  hitCodec,
  matchCodec,
  matchParts,
  searchPageCodec,
  sourceCodec,
} from "../../src/features/search/codecs";
import { destination, planningCapture } from "../../src/features/search/client";
import { parseRoute, routeHref } from "../../src/app/navigation";
import { decimal, decode, json, page, match, query, scope, response, wireHit } from "./fixtures";
describe("Native search capture contracts", () => {
  it("validates all nine source schemas and preserves separate revision meaning", () => {
    const sources = [
      { kind: "workspace", workspace_id: "workspace", revision: "0" },
      { kind: "project", project_id: "project", revision: "2" },
      { kind: "milestone", milestone_id: "milestone", revision: "3" },
      { kind: "ticket", ticket_id: "ticket", revision: "4" },
      { kind: "handoff", ticket_id: "ticket", revision: "5" },
      { kind: "comment", comment_id: "comment", revision: "6" },
      { kind: "resource", resource_id: "resource", revision: "7" },
      { kind: "resource_text", resource_id: "resource", revision: "8" },
      {
        kind: "fact",
        scope: { kind: "ticket", id: "ticket" },
        key: "a.b",
        revision: "9007199254740993",
      },
    ];
    for (const source of sources) {
      expect(sourceCodec.decode(json(source))).toEqual({ ok: true, value: source });
      expect(sourceCodec.decode(json({ ...source, id: "guessed" })).ok).toBe(false);
    }
    expect(
      sourceCodec.decode(json({ kind: "comment", comment_id: "comment", revision: "0" })).ok,
    ).toBe(false);
  });
  it("uses UTF8 byte offsets even above Number precision and refuses split code points", () => {
    const row = decode(matchCodec, {
      ...match,
      snippet: "a🦊b",
      snippet_offset: "9007199254740993",
      match_offset: "9007199254740994",
      match_bytes: "4",
    });
    expect(matchParts(row)).toEqual({ before: "a", match: "🦊", after: "b" });
    expect(matchCodec.decode(json({ ...row, match_bytes: "3" })).ok).toBe(false);
    expect(matchCodec.decode(json({ ...row, match_offset: "9007199254740995" })).ok).toBe(false);
  });
  it("decodes the combined closed page and refuses nonadvancing/unknown coverage", () => {
    expect(searchPageCodec.decode(json(page())).ok).toBe(true);
    expect(searchPageCodec.decode(json(page([], "0", "1"))).ok).toBe(false);
    expect(searchPageCodec.decode(json({ ...page(), extra: true })).ok).toBe(false);
    expect(
      searchPageCodec.decode(
        json({ ...page(), coverage: { ...page().coverage, unindexed_text_resources: "0" } }),
      ).ok,
    ).toBe(false);
    expect(
      searchPageCodec.decode(
        json({
          ...page(),
          unindexed_resources: {
            items: [
              {
                source: { kind: "resource_text", resource_id: "r", revision: "2" },
                reason: "prefix_only",
                indexed_bytes: "65536",
                omitted_bytes: "1",
                size_known: true,
              },
            ],
            offset: "0",
            remaining: "0",
            next_offset: null,
          },
        }),
      ).ok,
    ).toBe(true);
  });
  it("rejects shifted continuation captures and unexpected source kinds", () => {
    expect(planningCapture(scope, query, response(page()), decimal("0"), decimal("6")).ok).toBe(
      false,
    );
    expect(
      planningCapture(scope, { ...query, kinds: ["fact"] }, response(page()), decimal("0")).ok,
    ).toBe(false);
    expect(hitCodec.decode(json({ ...wireHit, matches: [] })).ok).toBe(false);
  });
  it("round trips exact comment and fact destinations and rejects contradictory URLs", () => {
    for (const source of [
      { kind: "comment", comment_id: "comment", revision: "3" },
      {
        kind: "fact",
        scope: { kind: "ticket", id: "ticket" },
        key: "a.b",
        revision: "9007199254740993",
      },
    ]) {
      const item = decode(hitCodec, { ...wireHit, source }),
        route = destination(scope, item);
      expect(route).not.toBeNull();
      if (route === null) throw new Error("Missing route");
      expect(parseRoute(routeHref(route))).toEqual({ ok: true, route });
      const url = routeHref(route);
      expect(parseRoute(url + "&fact_mode=current").ok).toBe(false);
    }
    const route = destination(
      scope,
      decode(hitCodec, {
        ...wireHit,
        source: { kind: "fact", scope: { kind: "workspace" }, key: "key", revision: "2" },
      }),
    );
    if (route === null) throw new Error("Missing route");
    expect(parseRoute(routeHref(route).replace("fact_mode=pinned", "fact_mode=current")).ok).toBe(
      false,
    );
    expect(
      parseRoute(routeHref(route).replace("fact_scope=workspace", "fact_scope=ticket")).ok,
    ).toBe(false);
    expect(
      destination(
        scope,
        decode(hitCodec, {
          ...wireHit,
          source: { kind: "resource_text", resource_id: "r", revision: "2" },
        }),
      ),
    ).toBeNull();
  });
});
