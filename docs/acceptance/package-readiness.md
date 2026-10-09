# Package validation and qualification scope

The package recipes preserve an explicit source allowlist and isolated compiler
selection. Native archives include complete offline guides and examples, upstream
license texts with an exact dependency inventory, the executable, file hashes and
an inspection record. The shared verifier rejects links, special files, unsafe or
duplicate paths, conflicting file/directory ancestry, unexpected modes, missing or
extra files, hash mismatches and inconsistent source identities before extraction.
It then checks installed tar/RPM contents against the validated native archive.

The embedded `QUALIFICATION.json` binds the executable SHA256, platform and source
identity with `status: inspection-only`. Final `qualification.json` is separate and
is written after installed runtime checks pass. Its archive hashes identify the
actual bundles tested. This distinguishes inspection from runtime qualification;
checksums establish agreement with the supplied archives, not publisher identity.

Independent Python fixtures cover malformed archives, source/native disagreement,
notice inventory/hash failures, provenance mismatch, installed-copy tampering,
exact RPM paths and nonempty extraction directories. Run them through:

```sh
./dev build @test/packaging/runtest
```

The [macOS recipe](../macos-install.md) requires Apple Silicon macOS, an already
provisioned OCaml 5.3.0 / Dune 3.21.1 / ocamlformat 0.28.1 switch, Bash, Git and Python 3.10+.
The [AlmaLinux recipe](../almalinux.md) requires native Linux AMD64 with an
x86-64-v3 CPU, an AMD64 Docker daemon, a nonroot UID/GID, Bash and Python 3.10+.
Both require fresh output directories. Neither publishes artifacts. The macOS
runtime removes switch and DYLD paths while the host toolchain remains installed.
The AlmaLinux tar and RPM run separately in fresh containers without build tools.
Both execute the smoke and recovery drivers shipped in the installed package.

Read-only revalidation on 2026-10-09 confirmed the prior
[AlmaLinux run 37705707734](https://github.com/dakotamurphyucf/workgraph/actions/runs/37705707734)
passed at commit `bcbb9e076e09e8d667510c8f7c89b1e57de0224e`. Its evidence records an
AMD EPYC 9V45 CPU with AVX2 on an Ubuntu 24.04 runner, AlmaLinux 10.2 container
userspace, successful tar/RPM installed checks and source identity
`0e0d363cfb474c54f624cbdb3e686922a4915c82a1d095811b702ff743bec54b`.
That result does not qualify the current workspace. The remote AlmaLinux workflow
remains active and manually dispatchable; no workflow was dispatched during this
readiness check. The new macOS workflow remains local until separately published.

Current-source native artifact qualification still requires the final repository
gate and platform package runs. A macOS linker minimum deployment target does not
establish execution on older macOS versions; Developer ID signing, notarization
and downloaded Gatekeeper launch are separate untested scopes. AlmaLinux container
qualification does not establish Windows, an actual WSL kernel or SELinux policy.
No current-source native AMD64 run or actual WSL run is claimed here.
