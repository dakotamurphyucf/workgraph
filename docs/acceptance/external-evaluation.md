# External evaluation measurements

`examples/evaluation.py` implements the external instrumentation portion of WG09.
It does not establish completion of the workspace metrics, admission-capacity,
resume/digest, harness-hook or packaging requirements.

The focused Python tests establish:

- Exact original results and exceptions survive the wrapper, including cancellation.
- Failed calls and exact retries count as observed client calls. No committed-write
  count or provider token estimate is inferred from those calls.
- Deterministic injected-clock latency totals and bounded recent quantiles agree
  with known observations; recent sampling does not truncate lifetime totals.
- Explicit usage observations reject invalid counts and conflicting reused IDs,
  deduplicate exact content, and cannot be changed through a returned report object.
- Request/response bodies and exception messages do not enter reports.
- A real daemon executes the documented read workload. A workload with two identical
  create requests records two returned calls; an invalid method is counted and stops
  later operations. A pre-existing report prevents dispatch, preserving its contents.

Executed on the development macOS ARM64 host:

```
python3 test/evaluation/evaluation_test.py examples/evaluation.py
# 4 tests passed
python3 test/evaluation/socket_test.py _build/default/bin/main.exe
# 1 test passed
python3 tools/check_agent_guide.py .
# passed
```

Both test files are included in `@test/evaluation/runtest` and the repository's
normal `@runtest` alias. These focused runs do not replace the final whole-tree
formatter/build/install checks or installed-artifact qualification on either target.
