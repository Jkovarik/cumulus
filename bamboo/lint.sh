#!/bin/bash
set -e
# This script is intented to run following bootstrap_lint_audit.sh
. ./bamboo/abort-if-not-pr-or-master.sh

npm install
npm run bootstrap-no-build
npm run lint