#!/usr/bin/env bash
# Release gate: the CHANGELOG section for the current composer.json version
# must declare its minimum compatible backend, e.g.
#   **Backend:** requires voltimax-ai-service >= v1.2.0
# Applies to every version released after 2.9.1 (older entries predate the rule).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(php -r 'echo json_decode(file_get_contents("composer.json"))->version;')

# Versions up to and including 2.9.1 are grandfathered
if printf '%s\n2.9.1\n' "$VERSION" | sort -V | tail -1 | grep -qx '2.9.1'; then
    echo "✓ v$VERSION predates the compat rule — skipping"
    exit 0
fi

SECTION=$(awk -v v="## $VERSION" '
    $0 == v {found=1; next}
    found && /^## / {exit}
    found {print}
' CHANGELOG.md)

if [ -z "$SECTION" ]; then
    echo "✗ CHANGELOG.md has no section '## $VERSION' for the composer.json version" >&2
    exit 1
fi

if ! grep -qE '\*\*Backend:\*\* requires voltimax-ai-service >= v[0-9]+\.[0-9]+\.[0-9]+' <<<"$SECTION"; then
    echo "✗ CHANGELOG section '## $VERSION' is missing the backend compatibility line:" >&2
    echo "    **Backend:** requires voltimax-ai-service >= vX.Y.Z" >&2
    exit 1
fi

echo "✓ v$VERSION declares its minimum backend version"
