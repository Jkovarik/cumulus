'use strict';

const fs = require('fs');
// eslint-disable-next-line node/no-unpublished-require
const yaml = require('js-yaml');
const { promisify } = require('util');
const configHelpers = require('./configHelpers');

const readFile = promisify(fs.readFile);

// Load config.yml into a Javscript object
const loadConfig = () => readFile('./config.yml', 'utf8').then(yaml.safeLoad);

const invokeHelper = (name) =>
  (serverless) =>
    loadConfig()
      .then((config) => configHelpers[name](serverless, config));

// Return deployToVpc as a string
const deployToVpc = (serverless) =>
  loadConfig()
    .then((config) => configHelpers.deployToVpc(serverless, config))
    .then((x) => `${x}`);

// The result of evaluating these functions is available in `serverless.yml` by
// using ${file(./config.js):propNameHere}
module.exports = {
  deployToVpc,
  logsPrefix: invokeHelper('logsPrefix'),
  permissionsBoundary: invokeHelper('permissionsBoundary'),
  vpcConfig: invokeHelper('vpcConfig'),
  deploymentBucket: invokeHelper('deploymentBucket'),
  logsBucket: invokeHelper('logsBucket'),
  prefix: invokeHelper('prefix'),
  stack: invokeHelper('stack'),
  subnetIds: invokeHelper('subnetIds'),
  vpcId: invokeHelper('vpcId')
};