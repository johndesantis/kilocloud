#!/bin/bash
set -e
echo "=== Running web typecheck ==="
pnpm --filter web exec tsc --noEmit --pretty 2>&1 | head -80 || true
echo "=== Typecheck exit code: $? ==="
