Name:           workgraph-ui
%{!?workgraph_version:%{error:Pass --define 'workgraph_version VERSION' from dune-project}}
Version:        %{workgraph_version}
Release:        1%{?dist}
Summary:        Optional local browser interface for Workgraph
License:        MIT
URL:            https://github.com/dakotamurphyucf/workgraph
Source0:        workgraph-ui-%{version}-almalinux-10-x86_64.tar.gz
ExclusiveArch:  x86_64
Requires:       workgraph%{?_isa} = %{version}-%{release}

# Core is dependency-owned. Never install or remove a second core executable,
# daemon state, user profiles, saved request journals or user workspace data.
%global debug_package %{nil}
%global __strip /bin/true
%global _build_id_links none
%undefine __brp_mangle_shebangs

%description
Optional Workgraph companion with embedded browser assets and notices. Node,
npm, an OCaml compiler and a frontend development server are not runtime
dependencies. The separately installed core RPM must match this exact release.
No service is started and no user data is installed or removed by this RPM.

%prep
%setup -q -n workgraph-ui-%{version}-almalinux-10-x86_64

%build
# Native compilation and tests precede deterministic archive creation.

%install
install -D -m 0755 bin/workgraph-ui %{buildroot}%{_bindir}/workgraph-ui
install -D -m 0644 LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE
cp -r THIRD_PARTY_NOTICES %{buildroot}%{_licensedir}/%{name}/
install -D -m 0644 ui-package/frontend-notices.txt %{buildroot}%{_licensedir}/%{name}/ui-package/frontend-notices.txt
mkdir -p %{buildroot}%{_docdir}/%{name}
cp -r README.md AGENTS.md engineering-standards.md docs skills tools packaging ui MANIFEST.json QUALIFICATION.json ui-package \
  %{buildroot}%{_docdir}/%{name}/
rm %{buildroot}%{_docdir}/%{name}/ui-package/frontend-notices.txt

%check
test "$(%{buildroot}%{_bindir}/workgraph-ui --version)" = '%{version}'

%files
%{_bindir}/workgraph-ui
%license %{_licensedir}/%{name}
%doc %{_docdir}/%{name}
