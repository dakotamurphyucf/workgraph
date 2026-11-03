# Install the Workgraph agent skill

A skill is a folder an agent can discover and read when a task calls for it.
Workgraph's skill explains how to plan work, preserve useful context and coordinate
workers through the Workgraph CLI. It includes the full README workflow overview,
focused guides, complete API schemas and runnable helpers. Installing the skill does not start a daemon or
install the Workgraph executable.

## Where to find it

The complete folder is [`skills/workgraph/`](../skills/workgraph/SKILL.md):

```text
workgraph/
├── SKILL.md          Entry point and capability map
├── README.md         Full overview and orchestration examples
├── LICENSE.txt       MIT license
├── references/       Setup, concepts and task-specific instructions
│   └── api/          Generated request/result schemas, one file per method
└── scripts/          Optional workflow, dashboard and history helpers
```

Copy the **whole `workgraph` folder**, not only `SKILL.md`. Internal links and
helper imports stay within this folder, so the copy does not need a repository
checkout beside it. Keep the skill matched to its CLI version. This skill targets
Workgraph 0.5 / application API 0.5; changing documentation does not migrate data.

**Availability:** this layout is in the current source checkout and newly built
packages. The already published v0.5.0 assets predate this change and still contain
`AGENT_GUIDE.md`, `docs/agent/`, `docs/api-reference/` and `examples/`. To use the new
skill with that executable, copy `skills/workgraph/` from this checkout. Do not
assume that re-downloading the old release will change its folder structure.

## Copy it into your harness

A harness is the application that runs the agent and supplies its tools. Use the
skill directory supported by your harness. For a harness configured to discover
skills under `~/.agents/skills`, run from this repository root:

```sh
mkdir -p "$HOME/.agents/skills"
test ! -e "$HOME/.agents/skills/workgraph" &&
  cp -R skills/workgraph "$HOME/.agents/skills/workgraph"
```

The check avoids merging a new copy with an existing installation. To replace an
older copy, move it aside first and copy the complete new folder; stale files
should not remain mixed into the new skill. For a different harness directory,
change only the destination. Refresh or restart skill discovery as your harness
requires. A harness without skill support can read `SKILL.md` directly and follow
its local reference links.

New native tarballs keep the folder at `skills/workgraph/` inside the extracted
bundle. New RPM packages place it at
`/usr/share/doc/workgraph/skills/workgraph/`. Copy that whole folder using the same
procedure. These paths describe packages built after the skill conversion.

## Give an agent the connection values

The skill supplies instructions; your local connection details are separate.
Give the agent the executable path and its own context file. The context file
contains the daemon socket, workspace ID, actor identity and optional run and
request-directory defaults. A socket is the local endpoint the CLI connects to.
Each worker should have its own actor/context and saved-request directory.

Example prompt, after substituting your actual paths:

```text
Use the workgraph skill at /absolute/skills/workgraph/SKILL.md.
The Workgraph executable is /absolute/bin/workgraph.
Your context file is /absolute/agent/context.json.
Use the supplied workspace to plan this assignment, record progress and decisions,
ask accountable questions, and leave a useful handoff. If orchestrating workers, first read the bundled README.md for the workflow overview
and delegation examples. Read focused references as needed for each operation. Reuse the existing connection and inspect the
current ticket before changing it.
```

If no workspace exists yet, say that explicitly and use the skill's
[getting-started guide](../skills/workgraph/references/getting-started.md).
Skill discovery does not create a workspace, authorize another agent process or
grant permissions beyond those provided by your harness.

## Check a copied skill

From the repository, this verifies internal links, the generated API inventory
and agreement with the supplied executable without opening a workspace:

```sh
python3 tools/check_skill.py "$HOME/.agents/skills/workgraph" \
  --binary /absolute/bin/workgraph
```

The checker uses Python's standard library. Native bundles include it under
`tools/check_skill.py`; the installed skill itself does not require a validator
or development toolchain to be read.

## Maintain the bundled overview

Edit the repository's root `README.md`, then run
`python3 tools/sync_skill_readme.py`. This generates the skill's full README with
local links to bundled references and scripts, and online links for repository-only
material. It preserves the inline script bodies. The test suite rejects a stale
copy, so the overview cannot silently drift from the maintained README.
