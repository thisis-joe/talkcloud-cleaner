#!/bin/zsh
set -e
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print 'Install Node.js 22 or newer and run this file again.'
  exit 1
fi
if [[ ! -f node_modules/playwright/package.json ]]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
node app.mjs
