#!/bin/sh
# Run: scripts/install-local.sh
# Input: this repo's source tree; the version in package.json.
# Output: a .vsix built by vsce, installed into this machine's VS Code
#   (the container's VS Code Server when run inside a devcontainer). The
#   .vsix is left in the repo — it is gitignored, and keeps a container
#   rebuild one command away from a working install.
#
# Reload the VS Code window afterward: an extension is read when the
# extension host starts, so a running window keeps the old build.
set -eu

cd "$(dirname "$0")/.."

# Never install a build whose parser is broken.
node --test test/*.test.js

VERSION=$(node -p "require('./package.json').version")

# --allow-missing-repository: the manifest has no "repository" field yet, and
# vsce treats that as an error rather than a warning.
npx --yes @vscode/vsce package --allow-missing-repository

# --force overwrites an install of the same version, which is the common case
# while developing. Version discipline belongs at promote time, not here.
code --install-extension "aichatrender-$VERSION.vsix" --force

echo
echo "Installed aichatrender-$VERSION."
echo "Run 'Developer: Reload Window' (or open a new window) to pick it up."
