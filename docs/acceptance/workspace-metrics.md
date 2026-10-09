# Workspace metrics acceptance

`workspace.metrics` is implemented with shared executable request/result codecs,
serialized daemon dispatch, a pure planning audit projection and persistence-owner
admission snapshots. It adds no durable query events or background metrics service.

Reviewed guarantees:

- Existing capacity guards and reported meters share `Admission.Limit` constants.
  Public meter decoding validates units, actual ceiling and remaining arithmetic.
- Planning payloads, full planning transactions and independent history batches are
  separate accounting sources. Facts retain tombstones/version bytes; uploads count
  declared reservations and remain private staging.
- Exact retries and reads do not count as new committed writes. Planning/history
  revisions remain distinct, with history head and both capture counters disclosed.
- Status intervals follow actual ticket status transitions in durable event order.
  Unrelated activity does not reset them. Unknown/regressed timestamps are explicitly
  counted, not treated as measured zero-length work. Sums saturate with disclosure.
- Reported token/elapsed totals remain explicit additive usage observations. Evidence
  record presence is not presented as proof that acceptance requirements are met.
- Final public envelope size is checked without clipping any counters or meters.
  Public codecs reject contradictory history/status/usage/capture observations.

Executed on the development macOS ARM64 host:

```
./dev build bin/main.exe @test/metrics/runtest @test/admission/runtest
```

Passed after runtime integration (session91050); real daemon socket test passed in
0.628s. The subsequent combined check8768 also passed these metrics/admission suites
and the new base planning-read suites, including sockets0.609s/0.838s. Its overall
exit was1 because a separate template-review public-field expectation disagreed;
that is owned by the acceptance API implementation, not claimed as a broad pass.

Coverage includes independent malformed admission JSON; fact tombstone accounting;
replayed completion/reopening timelines; unparseable/regressed clocks; reported
quantity overflow; contradictory capture counters/usage; real-daemon exact retries,
read-only observations, history independence,4KiB response budget, private upload
reservations and restart preservation/reset.

This evidence covers the metrics slice, not the whole WG09 resume/digest package or
final formatter/build/install and packaged-artifact qualification requirements.
