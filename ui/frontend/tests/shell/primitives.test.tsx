import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, StatePanel } from "../../src/components/Primitives";

describe("passive accessible shell content", () => {
  it("escapes full user content and attaches validation and hint text to its field", () => {
    const title = '<script>alert("fixture")</script> very long title remains available';
    const html = renderToStaticMarkup(
      <Field
        id="actor"
        label={title}
        hint="Existing work retains its writer"
        error="Invalid ID"
        defaultValue={title}
      />,
    );
    expect(html).toContain('aria-describedby="actor-hint actor-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('for="actor"');
    expect(html).toContain("very long title remains available");
    expect(html).not.toContain("<script>");
    expect(html).toContain('role="alert"');
  });
  it("distinguishes partial retained data, loading and errors semantically", () => {
    const loading = renderToStaticMarkup(
      <StatePanel kind="loading" title="Reading capture">
        Reading events
      </StatePanel>,
    );
    const partial = renderToStaticMarkup(
      <StatePanel kind="partial" title="Incomplete capture">
        Retained data is still readable
      </StatePanel>,
    );
    const failure = renderToStaticMarkup(
      <StatePanel kind="error" title="Read rejected">
        Permission denied
      </StatePanel>,
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    expect(partial).toContain("Retained data is still readable");
    expect(partial).not.toContain('aria-busy="true"');
    expect(failure).toContain('role="alert"');
  });
});
