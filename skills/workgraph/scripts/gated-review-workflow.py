#!/usr/bin/env python3
"""Execute and journal a complete two-actor, two-round review on an open workspace.

Usage: python3 gated-review-workflow.py EXE SOCKET WORKSPACE ABS_STATE_DIR
       [--prefix review-demo] [--worker worker] [--reviewer reviewer]
Use a fresh prefix and private state directory initially. Rerunning with the same
arguments retries saved successful mutations and reuses recorded read captures;
failed preparation reports are historical observations, never resubmitted later.
The harness owns the work and identities; Workgraph records cooperative attribution.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("socket")
    parser.add_argument("workspace")
    parser.add_argument("state_directory", type=Path)
    parser.add_argument("--prefix", default="review-demo")
    parser.add_argument("--worker", default="worker")
    parser.add_argument("--reviewer", default="reviewer")
    args = parser.parse_args()
    if not args.state_directory.is_absolute():
        parser.error("state directory must be absolute and private")
    if args.worker == args.reviewer:
        parser.error("worker and reviewer must use distinct cooperative actor IDs")
    if not args.prefix or len(args.prefix) > 40 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in args.prefix):
        parser.error("prefix must contain 1..40 ASCII letters, digits, underscores or hyphens")
    state = args.state_directory
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    executable = str(args.executable.resolve())
    configuration = {"socket": args.socket, "workspace": args.workspace, "prefix": args.prefix,
                     "worker": args.worker, "reviewer": args.reviewer}
    config_file = state / "workflow.json"
    if config_file.exists():
        if json.loads(config_file.read_text()) != configuration:
            parser.error("saved workflow arguments differ; use a fresh state directory")
    else:
        config_file.write_text(json.dumps(configuration, indent=2) + "\n")
        config_file.chmod(0o600)

    def invoke(argv):
        response = subprocess.run([executable, *argv], capture_output=True, text=True, timeout=30)
        if not response.stdout:
            raise RuntimeError(response.stderr or "CLI returned no JSON response")
        return json.loads(response.stdout)

    def save_report(path, response):
        if path.exists():
            if json.loads(path.read_text()) != response:
                raise RuntimeError("exact retry changed its saved response: " + str(path))
        else:
            path.write_text(json.dumps(response, indent=2) + "\n")
            path.chmod(0o600)

    def send(name, method, actor, run=None, **fields):
        params = {"workspace_id": args.workspace, "actor_id": actor, **fields}
        if run is not None:
            params["run_id"] = run
        saved = state / (name + ".request.json")
        report = state / (name + ".response.json")
        if saved.exists():
            response = invoke(["retry", args.socket, str(saved)])
        else:
            params_file = state / (name + ".params.json")
            params_file.write_text(json.dumps(params) + "\n")
            params_file.chmod(0o600)
            response = invoke(["request", args.socket, method, "--params-file", str(params_file), "--save-request", str(saved)])
        save_report(report, response)
        return response

    def mutate(name, method, actor, run=None, **fields):
        response = send(name, method, actor, run, **fields)
        if "error" in response:
            raise RuntimeError("unexpected failure at " + name + ": " + json.dumps(response["error"]))
        return response["result"]["data"]

    def read(name, method, **fields):
        report = state / (name + ".read.json")
        if report.exists():
            return json.loads(report.read_text())["result"]["data"]
        response = invoke(["call", args.socket, method, json.dumps({"workspace_id": args.workspace, **fields})])
        if "error" in response:
            raise RuntimeError("unexpected read failure at " + name + ": " + json.dumps(response["error"]))
        save_report(report, response)
        return response["result"]["data"]

    prefix = args.prefix
    project, ticket = prefix + "-project", prefix + "-ticket"
    worker_run, reviewer_run, attempt = prefix + "-worker", prefix + "-reviewer", prefix + "-attempt"
    schema_id, output_id, contract_id, manifest_id = (prefix + suffix for suffix in ("-schema", "-output", "-contract", "-manifest"))
    mutate("project", "project.create", args.worker, project_id=project, title="Two-round review")
    mutate("ticket", "ticket.create", args.worker, project_id=project, ticket_id=ticket, title="Publish a reviewed result")
    worker_record = mutate("worker-run", "run.register", args.worker, target_run_id=worker_run, objective="Produce and revise the result")
    reviewer_record = mutate("reviewer-run", "run.register", args.reviewer, target_run_id=reviewer_run, objective="Verify exact output pins")
    started = mutate("start", "ticket.start", args.worker, worker_run, ticket_id=ticket, attempt_id=attempt)
    token = started["token"]

    # Actor catalogs are metadata. separate_actor checks cooperating identifiers;
    # it does not authenticate either caller. Ownership tokens fence stale writers.
    mutate("policy", "review.policy.put", args.worker, worker_run, ticket_id=ticket, expected_revision="0",
           enabled=True, reviewers=[{"kind": "actor", "actor_id": args.reviewer}], separate_actor=True, validators=[])
    schema = mutate("schema", "resource.put_text", args.worker, worker_run, resource_id=schema_id,
                    expected_revision="0", title="Result schema", text='{"type":"object","required":["answer"]}')

    def pin(resource_id, publication):
        return {"resource_id": resource_id, "revision": publication["version"]["revision"], "digest": publication["version"]["digest"]}

    def verify_resource(name, resource_id, publication):
        content = read(name, "resource.read", resource_id=resource_id,
                       version=publication["version"]["revision"])
        if content["digest"] != publication["version"]["digest"]:
            raise RuntimeError("reviewed resource differs from its immutable manifest pin")
        return json.loads(content["text"])

    contract = mutate("contract", "contract.put", args.worker, worker_run, contract_id=contract_id,
                      expected_revision="0", schema_version="1", schema=pin(schema_id, schema), required_inputs=[], required_outputs=["result"])
    contract_ref = {"contract_id": contract_id, "revision": contract["revision"]}
    output1 = mutate("output-first", "resource.put_text", args.worker, worker_run, resource_id=output_id,
                     expected_revision="0", title="Candidate result", text='{"answer":"needs correction"}')
    manifest1 = mutate("manifest-first", "manifest.publish", args.worker, worker_run, manifest_id=manifest_id,
                       expected_revision="0", schema_version="1", attempt_id=attempt, ticket_id=ticket,
                       contract=contract_ref, inputs=[], outputs=[{"name": "result", "pin": {"kind": "resource", **pin(output_id, output1)}}])
    manifest_ref1 = {"manifest_id": manifest_id, "revision": manifest1["revision"]}
    first = mutate("submit-first", "review.submit", args.worker, worker_run, ticket_id=ticket, expected_revision="0", manifest=manifest_ref1)
    first_request = first["review_request_id"]
    initial_gate = read("gate-before-review", "review.gate", ticket_id=ticket)
    if initial_gate["allowed"]:
        raise RuntimeError("configured reviewer gate unexpectedly allowed work before review")
    blocked_file = state / "expected-block.response.json"
    if blocked_file.exists():
        blocked = json.loads(blocked_file.read_text())
    else:
        blocked = send("expected-block", "ticket.finish", args.worker, worker_run,
                       ticket_id=ticket, token=token, evidence="Intentional check before reviewer acceptance")
    if blocked.get("error", {}).get("data", {}).get("kind") != "Blocked":
        raise RuntimeError("expected policy block differed: " + json.dumps(blocked))

    checked_schema = verify_resource("review-schema", schema_id, schema)
    checked_first = verify_resource("review-first-output", output_id, output1)
    if checked_schema["required"] != ["answer"] or checked_first.get("answer") != "needs correction":
        raise RuntimeError("first review did not inspect the expected pinned candidate")
    mutate("request-changes", "review.record", args.reviewer, reviewer_run, review_id=prefix + "-changes",
           ticket_id=ticket, generation=first["generation"], verdict="request_changes", evidence="Correct the answer and resubmit exact output pins")
    rejected = read("rejected-submission", "review.submission.get", ticket_id=ticket)
    requests = read("change-requests", "request.list", kind="blocker_resolution", recipient={"kind": "actor", "id": args.worker}, open_only=True)
    changes_request = next(request for request in requests["items"] if request["reply_to_request_id"] == first_request)
    output2 = mutate("output-revised", "resource.put_text", args.worker, worker_run, resource_id=output_id,
                     expected_revision=output1["revision"], title="Corrected result", text='{"answer":"verified correction"}')
    manifest2 = mutate("manifest-revised", "manifest.publish", args.worker, worker_run, manifest_id=manifest_id,
                       expected_revision=manifest1["revision"], schema_version="1", attempt_id=attempt, ticket_id=ticket,
                       contract=contract_ref, inputs=[], outputs=[{"name": "result", "pin": {"kind": "resource", **pin(output_id, output2)}}])
    manifest_ref2 = {"manifest_id": manifest_id, "revision": manifest2["revision"]}
    second = mutate("submit-revised", "review.submit", args.worker, worker_run, ticket_id=ticket,
                    expected_revision=rejected["revision"], manifest=manifest_ref2)
    checked_second = verify_resource("review-corrected-output", output_id, output2)
    if checked_second.get("answer") != "verified correction":
        raise RuntimeError("reviewer did not verify the correction at the exact output pin")
    approval = mutate("approve", "review.record", args.reviewer, reviewer_run, review_id=prefix + "-approved",
                      ticket_id=ticket, generation=second["generation"], verdict="approve", evidence="Verified the correction at the recorded output pin")
    after_approval = read("submission-after-approval", "review.submission.get", ticket_id=ticket)
    if after_approval["revision"] != second["revision"]:
        raise RuntimeError("approval unexpectedly changed the submission revision")

    # The reviewer resolves the changes request they designated; the worker
    # resolves the superseded formal review request they created. Other requests
    # remain independent. Accept later resolves only this current review request.
    mutate("resolve-changes", "request.resolve", args.reviewer, reviewer_run,
           request_id=changes_request["request_id"], expected_revision=changes_request["revision"])
    first_request_record = read("superseded-review-request", "request.get", request_id=first_request)
    mutate("resolve-superseded-review", "request.resolve", args.worker, worker_run,
           request_id=first_request, expected_revision=first_request_record["revision"])
    packets = read("approval-inbox", "inbox.read", consumer_id=prefix + "-inbox", recipient={"kind": "run", "id": worker_run},
                   after="0", kinds=["message_received"])
    payloads = [json.loads(packet["body_source"]["body"]) for packet in packets["items"]]
    notice = next(payload for payload in payloads if payload.get("kind") == "review_approved" and payload["review_id"] == approval["review_id"])
    if notice["generation"] != second["generation"] or notice["manifest"] != manifest_ref2 or notice["gate_status"] != "not_evaluated":
        raise RuntimeError("approval notification lost its exact immutable references")
    accepted = mutate("accept", "review.accept", args.worker, worker_run, ticket_id=ticket, expected_revision=second["revision"])
    gate = read("gate-after-acceptance", "review.gate", ticket_id=ticket)
    if not gate["allowed"]:
        raise RuntimeError("accepted current manifest did not satisfy the configured reviewer gate")
    finished = mutate("finish", "ticket.finish", args.worker, worker_run, ticket_id=ticket, token=token,
                      evidence="Two review rounds completed, requests resolved and exact outputs accepted",
                      handoff={"summary": "Corrected output reviewed and accepted", "next_steps": "Inspect the immutable manifest and review", "resource_ids": [output_id]})
    if finished["attempt"] != {"attempt_id": attempt, "revision": "2", "state": "completed"}:
        raise RuntimeError("atomic finish did not complete the active attempt")
    print(json.dumps({"ticket_id": ticket, "worker_run_revision": worker_record["revision"],
                      "reviewer_run_revision": reviewer_record["revision"], "start": started,
                      "contract": contract_ref, "first_manifest": manifest_ref1, "second_manifest": manifest_ref2,
                      "first_generation": first["generation"], "second_generation": second["generation"],
                      "submission_revision_after_approval": after_approval["revision"], "accepted_revision": accepted["revision"],
                      "approval_notification": notice, "resolved_changes_request": changes_request["request_id"],
                      "resolved_superseded_review_request": first_request, "finish": finished,
                      "expected_policy_blocks": [blocked["error"]["data"]["kind"]], "unexpected_failures": []}, indent=2))


if __name__ == "__main__":
    main()
