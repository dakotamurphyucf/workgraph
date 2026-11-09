/** Isolated field lifetime regression; actual daemon flows use facts.browser.ts. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createProtocolProcessor, type ProtocolProcessor } from "../../../src/core/protocol/worker";
import type { FactEditInput } from "../../../src/features/knowledge/facts/types";
import { copyInput } from "../../../src/features/knowledge/facts/model";
import { ValueEditor } from "../../../src/features/knowledge/facts/ValueEditor";
const original = '{"word":"","number":0,"__proto__":{"constructor":null}}',
  jobs: (() => void)[] = [];
let hold = false,
  encodes = 0;
const real = createProtocolProcessor(),
  processing: ProtocolProcessor = {
    ...real,
    encode: (value, options) => {
      encodes++;
      return hold
        ? new Promise((resolve, reject) => {
            jobs.push(() => {
              void real.encode(value).then(resolve, reject);
            });
          })
        : real.encode(value, options);
    },
  };
export function Fixture() {
  const [input, setInput] = useState<FactEditInput>({
      source: original,
      references: { kind: "preserve" },
    }),
    [shown, setShown] = useState(true),
    [blocked, setBlocked] = useState(false),
    [released, setReleased] = useState(0);
  return (
    <>
      <h1>Fact editor lifetime</h1>
      <p role="status">
        Parent {blocked ? "blocked" : "ready"}; released {released}
      </p>
      <output aria-label="Encoding count">{encodes}</output>
      <output aria-label="Retained fact source">{input.source}</output>
      <label>
        <input
          type="checkbox"
          onChange={(event) => {
            hold = event.currentTarget.checked;
          }}
        />
        Hold structured encoding
      </label>
      <button
        onClick={() => {
          const pending = jobs.splice(0);
          pending.forEach((run) => run());
          setReleased(pending.length);
        }}
      >
        Release old encoding
      </button>
      <button onClick={() => setShown((v) => !v)}>Navigate away or back</button>
      {shown && (
        <ValueEditor
          source={input.source}
          candidate={input.structured}
          onCandidate={(structured) =>
            setInput((previous) => copyInput({ ...previous, structured }))
          }
          onEncoded={(source, structured) =>
            setInput((previous) =>
              previous.structured === structured && previous.source !== source
                ? copyInput({ ...previous, source, structured })
                : previous,
            )
          }
          onChange={(source) => setInput(copyInput({ source, references: input.references }))}
          disabled={false}
          processing={processing}
          onBlocked={setBlocked}
        />
      )}
    </>
  );
}
const mount = document.getElementById("fixture");
if (mount === null) throw new Error("Missing fixture root");
createRoot(mount).render(<Fixture />);
