/** Isolated component regression. Actual native authoring uses authoring.browser.ts. */
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { createProtocolProcessor, type ProtocolProcessor } from "../../../src/core/protocol/worker";
import * as d from "../../../src/core/protocol/decoders";
import { StructuredField } from "../../../src/features/workflow/evidence/StructuredField";
import type { FieldInput } from "../../../src/features/workflow/evidence/types";
const original = '["original"]',
  jobs: (() => void)[] = [];
let holdEncode = true,
  holdParse = true;
const real = createProtocolProcessor(),
  processing: ProtocolProcessor = {
    ...real,
    encode: (value, options) =>
      holdEncode
        ? new Promise((resolve) => {
            jobs.push(() => {
              void real.encode(value).then(resolve);
            });
          })
        : real.encode(value, options),
    parse: (source, options) =>
      holdParse
        ? new Promise((resolve) => {
            jobs.push(() => {
              void real.parse(source).then(resolve);
            });
          })
        : real.parse(source, options),
  };
function ScopeFixture({
  name,
  label,
  source,
}: {
  readonly name: string;
  readonly label: string;
  readonly source: string;
}) {
  const [input, setInput] = useState<FieldInput>({ presence: "value", text: source });
  const block = useCallback(() => {}, []);
  return (
    <section aria-label={label}>
      <StructuredField
        field={{ name, label, type: "json" }}
        input={input}
        processing={real}
        onChange={setInput}
        onBlocked={block}
        disabled={false}
      />
      <output aria-label={`${label} retained source`}>{input.text}</output>
    </section>
  );
}
export function Fixture() {
  const [input, setInput] = useState<FieldInput>({
      presence: "value",
      text: original,
      value: d.jsonArray([d.jsonString("original")]),
    }),
    [shown, setShown] = useState(true),
    [blocked, setBlocked] = useState(false),
    [pending, setPending] = useState(0);
  const block = useCallback((_name: string, value: boolean) => setBlocked(value), []);
  return (
    <>
      <h1>Structured field lifetime</h1>
      <ScopeFixture
        name="inherited_override"
        label="Inherited override"
        source={
          '{"against":{"scope":{"kind":"project","project_id":"inherited-project"},"revision":"1"},"membership_revision":"1","reviewers":[],"validators":[],"criteria":[],"waive_separate_actor":false,"reason":"Audited waiver"}'
        }
      />
      <ScopeFixture
        name="scope"
        label="Policy scope"
        source={'{"kind":"ticket","ticket_id":"selected-ticket"}'}
      />
      <ScopeFixture name="scope" label="Decision scope" source={'{"kind":"workspace"}'} />
      <label>
        <input
          type="checkbox"
          defaultChecked
          onChange={(event) => {
            holdEncode = event.currentTarget.checked;
          }}
        />
        Hold encode
      </label>
      <label>
        <input
          type="checkbox"
          defaultChecked
          onChange={(event) => {
            holdParse = event.currentTarget.checked;
          }}
        />
        Hold parse
      </label>
      <button
        onClick={() => {
          setShown((value) => !value);
        }}
      >
        Toggle optional field
      </button>
      <button
        onClick={() => {
          const captured = jobs.splice(0);
          for (const job of captured) job();
          setPending(captured.length);
        }}
      >
        Release deferred jobs
      </button>
      <p role="status">
        Parent {blocked ? "blocked" : "ready"}; released {pending}
      </p>
      <output aria-label="Retained source">{input.text}</output>
      {shown && (
        <StructuredField
          field={{ name: "required_outputs", label: "Output names", type: "json" }}
          input={input}
          processing={processing}
          onChange={setInput}
          onBlocked={block}
          disabled={false}
        />
      )}
    </>
  );
}
const root = document.getElementById("fixture");
if (root === null) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
