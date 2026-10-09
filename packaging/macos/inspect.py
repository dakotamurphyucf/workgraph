#!/usr/bin/env python3
"""Reject non-system macOS dependencies; record actual Mach-O deployment target."""
import json
from pathlib import Path
import platform
import re
import subprocess
import sys

binary, destination = map(Path, sys.argv[1:])

def command(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout

architectures = command('lipo', '-archs', str(binary)).strip().split()
if architectures != ['arm64']:
    raise SystemExit('Expected an ARM64-only executable: ' + repr(architectures))
linked = command('otool', '-L', str(binary))
dependencies = [line.strip().split(' (', 1)[0] for line in linked.splitlines()[1:]]
unsupported = [name for name in dependencies if not name.startswith(('/usr/lib/', '/System/Library/'))]
if unsupported:
    raise SystemExit('Non-system dependencies require explicit bundling and license review: ' + repr(unsupported))
loads = command('otool', '-l', str(binary))
if re.search(r'\bcmd LC_RPATH\b', loads):
    raise SystemExit('Unexpected executable runtime search path; review before packaging')
minimum = re.search(r'\bminos\s+(\S+)', loads)
if minimum is None:
    minimum = re.search(r'cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\S+)', loads)
if minimum is None:
    raise SystemExit('Could not establish Mach-O minimum macOS version')
signature = subprocess.run(['codesign', '-dv', str(binary)], text=True, capture_output=True)
result = {'architecture': architectures, 'dependencies': dependencies,
          'mach_o_minimum_macos': minimum[1], 'tested_macos': platform.mac_ver()[0],
          'load_commands': loads.replace(str(binary), 'bin/workgraph'), 'code_signature': {'exit_code': signature.returncode, 'details': re.sub(r'^Executable=.*$', 'Executable=bin/workgraph', signature.stderr, flags=re.M)},
          'signing_scope': 'No Developer ID signing or notarization performed by packaging'}
destination.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
