"""Real local evidence inspection, selected-source identity and conservative cleanup."""
import base64
import fcntl
import json
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import time

binary = str(Path(sys.argv[1]).resolve())


def cli(*args, code=0):
    result = subprocess.run([binary, *map(str, args)], capture_output=True, timeout=10)
    assert result.returncode == code, (args, result.stdout, result.stderr)
    return result


with tempfile.TemporaryDirectory(prefix="wg-inspect-", dir="/tmp") as temporary:
    root = Path(temporary)
    repo = root / "repo"
    repo.mkdir()

    def git(*args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-C", str(repo), *args], check=True, capture_output=True)

    git("init", "--quiet")
    (repo / "chosen").write_text("selected bytes")
    (repo / "other").write_text("other bytes")
    (repo / ".gitignore").write_text("ignored\n")
    (repo / "ignored").write_text("explicit ignored selection")
    git("add", "chosen", "other", ".gitignore")
    git("commit", "--quiet", "-m", "initial")
    stage = root / "stage"
    script = "import os; from pathlib import Path; Path('other').write_text('unrelated changed'); os.write(1,b'abcdefghEND-LOST'); os.write(2,b'bad\\xff\\x00')"
    summary = json.loads(cli("evidence-run", "--stage", stage, "--cwd", repo, "--source-root", repo, "--hash-path", "chosen", "--output-limit", "8", "--", sys.executable, "-c", script).stdout)
    assert summary["source_drift"] is False
    assert summary["source_before"]["scope"] == {"kind": "paths", "paths": ["chosen"]}
    assert summary["source_before"]["listed_paths"] == summary["source_before"]["hashed_paths"] == "1"
    assert summary["source_before"]["identity_complete"]
    preview = summary["stdout_preview"]
    assert preview["text"] == "abcdefgh" and preview["retention"] == "prefix" and preview["selection"] == "retained_tail"
    assert preview["observed_bytes"] == "16" and preview["retained_bytes"] == "8"
    assert not preview["at_observed_end"] and preview["truncated"] and preview["eof"]
    assert summary["stderr_preview"]["text_lossy"]
    tail = json.loads(cli("--context", root / "absent-context", "evidence", "show", "--stage", stage, "--stdout", "--tail", "4", "--output", "json").stdout)
    assert tail["text"] == "efgh" and tail["offset"] == "4" and not tail["at_observed_end"]
    exact = cli("evidence.show", "--stage", stage, "--stderr", "--offset", "2", "--length", "3", "--output", "bytes")
    assert exact.stdout == b"d\xff\x00" and json.loads(exact.stderr)["text_lossy"]
    assert b"Decoded output" in cli("evidence-show", "--stage", stage).stdout
    for extra in [["--offset", "9"], ["--length", "65537"], ["--tail", "1", "--offset", "0"]]:
        cli("evidence-show", "--stage", stage, *extra, code=1)
    for spelling in [["evidence-show"], ["evidence", "show"], ["evidence.show"], ["evidence-clean"], ["evidence", "clean"], ["evidence.clean"]]:
        assert b"[local helper]" in cli("--context", root / "absent-context", *spelling, "--help").stdout

    # Changing HEAD alone does not change an explicitly selected file identity.
    head_stage = root / "head-stage"
    head_script = "import subprocess; from pathlib import Path; Path('other').write_text('new commit'); subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-am','unrelated','--quiet'],check=True)"
    selected = json.loads(cli("evidence-run", "--stage", head_stage, "--cwd", repo, "--source-root", repo, "--hash-path", "chosen", "--", sys.executable, "-c", head_script).stdout)
    assert selected["source_drift"] is False
    ignored_stage = root / "ignored-stage"
    ignored = json.loads(cli("evidence-run", "--stage", ignored_stage, "--cwd", repo, "--source-root", repo, "--hash-path", "ignored", "--", sys.executable, "-c", "from pathlib import Path; Path('ignored').write_text('changed')").stdout)
    assert ignored["source_drift"] is True
    (repo / "too-large").write_bytes(b"x" * (8*1024*1024 + 1))
    partial = json.loads(cli("evidence-run", "--stage", root / "partial", "--cwd", repo, "--source-root", repo, "--", "/usr/bin/true").stdout)
    assert partial["source_drift"] is None
    assert partial["source_before"]["omissions"] == {"file_byte_limit": "1"}
    assert not partial["source_before"]["identity_complete"]
    for invalid in ["../chosen", "/absolute", ".git/config", "a//b", "."]:
        denied = root / ("invalid-" + str(len(list(root.iterdir()))))
        cli("evidence-run", "--stage", denied, "--cwd", repo, "--source-root", repo, "--hash-path", invalid, "--", "/usr/bin/true", code=1)
        assert not denied.exists()

    token = summary["owner_token"]
    original = {p.name: p.read_bytes() for p in stage.iterdir()}
    assert b"token differs" in cli("evidence-clean", "--stage", stage, "--owner-token", "0"*64, code=1).stderr
    foreign = root / "foreign"
    foreign.mkdir()
    for name in ["command.json", "capture.json"]: shutil.copyfile(stage / name, foreign / name)
    cli("evidence-clean", "--stage", foreign, "--owner-token", token, code=1)
    assert (foreign / "capture.json").exists()
    (stage / "foreign-file").write_text("do not delete")
    cli("evidence-clean", "--stage", stage, "--owner-token", token, code=1)
    assert (stage / "foreign-file").read_text() == "do not delete"
    (stage / "foreign-file").unlink()
    with (stage / "command.json").open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        cli("evidence-clean", "--stage", stage, "--owner-token", token, code=1)
    alias = root / "alias"
    alias.symlink_to(stage, target_is_directory=True)
    cli("evidence-clean", "--stage", alias, "--owner-token", token, code=1)
    assert {p.name: p.read_bytes() for p in stage.iterdir()} == original
    # A saved publication intent always fences cleanup, even if no peer exists.
    cli("evidence-publish", root / "absent-socket", "--stage", stage, "--workspace-id", "w", "--actor-id", "a", "--resource-id", "e", "--expected-revision", "0", "--title", "Evidence", code=1)
    assert (stage / "publication.json").exists()
    cli("evidence-clean", "--stage", stage, "--owner-token", token, code=1)
    assert (stage / "publication.json").exists()
    # Cleanup succeeds only for a finished, unchanged owned stage without intent.
    cli("evidence", "clean", "--stage", ignored_stage, "--owner-token", ignored["owner_token"])
    assert not ignored_stage.exists()

    live = root / "live"
    release = root / "release"
    ready = root / "child-ready"
    live_script = "from pathlib import Path; import time,sys; p=Path(sys.argv[1]); Path(sys.argv[2]).touch();\nwhile not p.exists(): time.sleep(.01)"
    child = subprocess.Popen([binary, "evidence-run", "--stage", str(live), "--cwd", str(root), "--", sys.executable, "-c", live_script, str(release), str(ready)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 5
        # The child launches after stage initialization. File existence alone
        # can race the parent's still-in-progress ownership JSON write.
        while not ready.exists():
            assert child.poll() is None and time.monotonic() < deadline
            time.sleep(.01)
        live_token = json.loads((live / "owner.json").read_text())["token"]
        blocked = cli("evidence-clean", "--stage", live, "--owner-token", live_token, code=1)
        assert b"live" in blocked.stderr and (live / "command.json").exists()
        release.touch()
        out, err = child.communicate(timeout=5)
        assert child.returncode == 0, (out, err)
        cli("evidence-clean", "--stage", live, "--owner-token", live_token)
        assert not live.exists()
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
print("Evidence inspection, declared source identity and owned cleanup passed")
