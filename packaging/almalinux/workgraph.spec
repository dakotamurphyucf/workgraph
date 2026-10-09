Name:           workgraph
Version:        0.1.0
Release:        2%{?dist}
Summary:        Local durable project memory for agents
License:        MIT
URL:            https://github.com/dakotamurphyucf/workgraph
Source0:        workgraph-%{version}-almalinux-10-x86_64.tar.gz
ExclusiveArch:  x86_64

# This RPM installs the native archive built and tested by build.sh. Preserve the
# executable and example-script bytes so both packages match the same manifest.
%global debug_package %{nil}
%global __strip /bin/true
%global _build_id_links none
%undefine __brp_mangle_shebangs

%description
Workgraph is a local durable planning and history service with a Unix socket CLI.
It runs in the foreground and does not require or install a systemd service.
The native archive is built from the packaged source in an isolated AlmaLinux 10
environment before this RPM is created. No OCaml toolchain is needed at runtime.

%prep
%setup -q -n workgraph-%{version}-almalinux-10-x86_64

%build
# Compilation and complete tests occur before native archive generation.

%install
install -D -m 0755 bin/workgraph %{buildroot}%{_bindir}/workgraph
install -D -m 0644 LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE
cp -r THIRD_PARTY_NOTICES %{buildroot}%{_licensedir}/%{name}/
mkdir -p %{buildroot}%{_docdir}/%{name}
cp -r README.md AGENTS.md AGENT_GUIDE.md engineering-standards.md docs examples tools packaging MANIFEST.json QUALIFICATION.json \
  %{buildroot}%{_docdir}/%{name}/

%check
test "$(%{buildroot}%{_bindir}/workgraph --version)" = '%{version}'

%files
%{_bindir}/workgraph
%license %{_licensedir}/%{name}
%doc %{_docdir}/%{name}
