#!/bin/bash
# Required to allow distribution module to build.
# Temporary fix, will be replaced with permanent solution in CUMULUS-1408.
set +e;
apt-get update;
set -e;
apt-get install -y zip
# End temp fix
set -ex
. ./bamboo/abort-if-not-pr-or-redeployment.sh
. ./bamboo/abort-if-skip-integration-tests.sh

npm config set unsafe-perm true
npm install
. ./bamboo/set-bamboo-env-variables.sh
. ./bamboo/abort-tests-if-no-code-change.sh


if [[ $USE_NPM_PACKAGES == true ]]; then
  echo "***Deploying stack with NPM packages"
  (cd example && npm install)
else
  echo "***Deploying stack with built packages"
  npm run bootstrap
fi

echo "Locking stack for deployment $DEPLOYMENT"

cd example
set +e

# Wait for the stack to be available
node ./scripts/lock-stack.js true $DEPLOYMENT
LOCK_EXISTS_STATUS=$?
echo "Locking status $LOCK_EXISTS_STATUS"

COUNTER=0
while [[ $LOCK_EXISTS_STATUS == 100 ]]; do
  if [[ $COUNTER -gt $TIMEOUT_PERIODS ]]; then
    echo "Timed out waiting for stack to become available"
    exit 1
  fi
  echo "Another build is using the ${DEPLOYMENT} stack."
  sleep 30
  ((COUNTER++))
  node ./scripts/lock-stack.js true $DEPLOYMENT
  LOCK_EXISTS_STATUS=$?
done
if [[ $LOCK_EXIST_STATUS -gt 0 ]]; then
  exit 1
fi
set -e

if [[ $KES_DEPLOYMENT == true ]]; then
  echo "Running Kes deployment $DEPLOYMENT"
  . ../bamboo/bootstrap-kes-deployment.sh
else
  echo "Running Terraform deployment $DEPLOYMENT"
  . ../bamboo/bootstrap-tf-deployment.sh
fi
