'use strict';

const request = require('supertest');
const test = require('ava');
const get = require('lodash.get');
const sinon = require('sinon');
const aws = require('@cumulus/common/aws');

const { randomString } = require('@cumulus/common/test-utils');

const models = require('../../../models');
const assertions = require('../../../lib/assertions');
const {
  createFakeJwtAuthToken
} = require('../../../lib/testUtils');
const { Search, defaultIndexAlias } = require('../../../es/search');
const { bootstrapElasticSearch } = require('../../../lambdas/bootstrap');
const mappings = require('../../../models/mappings.json');

const esIndex = 'cumulus-1';

process.env.AccessTokensTable = randomString();
process.env.UsersTable = randomString();
process.env.AsyncOperationsTable = randomString();
process.env.TOKEN_SECRET = randomString();
process.env.ES_INDEX = esIndex;
process.env.stackName = randomString();
process.env.system_bucket = randomString();

// import the express app after setting the env variables
const { app } = require('../../../app');

let jwtAuthToken;
let accessTokenModel;
let userModel;
let asyncOperationsModel;

const indexAlias = 'cumulus-1-alias';
let esClient;

/**
 * Index fake data
 *
 * @returns {undefined} - none
 */
async function indexData() {
  const rules = [
    { name: 'Rule1' },
    { name: 'Rule2' },
    { name: 'Rule3' }
  ];

  await Promise.all(rules.map(async (rule) => {
    await esClient.index({
      index: esIndex,
      type: 'rule',
      id: rule.name,
      body: rule
    });
  }));

  await esClient.indices.refresh();
}

/**
 * Create and alias index by going through ES bootstrap
 *
 * @param {string} indexName - index name
 * @param {string} aliasName  - alias name
 * @returns {undefined} - none
 */
async function createIndex(indexName, aliasName) {
  await bootstrapElasticSearch('fakehost', indexName, aliasName);
  esClient = await Search.es();
}

test.before(async () => {
  userModel = new models.User();
  await userModel.createTable();

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  asyncOperationsModel = new models.AsyncOperation({
    stackName: process.env.stackName,
    systemBucket: process.env.system_bucket,
    tableName: process.env.AsyncOperationsTable
  });
  await asyncOperationsModel.createTable();

  await aws.s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, userModel });

  // create the elasticsearch index and add mapping
  await createIndex(esIndex, indexAlias);

  await indexData();
});

test.after.always(async () => {
  await accessTokenModel.deleteTable();
  await asyncOperationsModel.deleteTable();
  await userModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await aws.recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test('PUT snapshot without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/create-snapshot')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('PUT snapshot with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/create-snapshot')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(403);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.serial('Reindex - multiple aliases found', async (t) => {
  // Prefixes for error message predictability
  const indexName = `z-${randomString()}`;
  const otherIndexName = `a-${randomString()}`;

  const aliasName = randomString();

  await esClient.indices.create({
    index: indexName,
    body: { mappings }
  });

  await esClient.indices.putAlias({
    index: indexName,
    name: aliasName
  });

  await esClient.indices.create({
    index: otherIndexName,
    body: { mappings }
  });

  await esClient.indices.putAlias({
    index: otherIndexName,
    name: aliasName
  });

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ aliasName })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `Multiple indices found for alias ${aliasName}. Specify source index as one of [${otherIndexName}, ${indexName}].`);

  await esClient.indices.delete({ index: indexName });
  await esClient.indices.delete({ index: otherIndexName });
});

test.serial('Reindex - specify a source index that does not exist', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ aliasName: indexAlias, sourceIndex: 'source-index' })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Source index source-index does not exist.');
});

test.serial('Reindex - specify a source index that is not aliased', async (t) => {
  const indexName = 'source-index';

  await esClient.indices.create({
    index: indexName,
    body: { mappings }
  });

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({ aliasName: indexAlias, sourceIndex: indexName })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Source index source-index is not aliased with alias cumulus-1-alias.');

  await esClient.indices.delete({ index: indexName });
});

test.serial('Reindex success', async (t) => {
  const destIndex = randomString();

  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName: indexAlias,
      destIndex,
      sourceIndex: esIndex
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message, `Reindexing to ${destIndex} from ${esIndex}. Check the reindex-status endpoint for status.`);

  // Check the reindex status endpoint to see if the operation has completed
  let statusResponse = await request(app)
    .get('/elasticsearch/reindex-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  /* eslint-disable no-await-in-loop */
  while (Object.keys(statusResponse.body.reindexStatus.nodes).length > 0) {
    statusResponse = await request(app)
      .get('/elasticsearch/reindex-status')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);
  }
  /* eslint-enable no-await-in-loop */

  const indexStatus = statusResponse.body.indexStatus.indices[destIndex];

  t.is(3, indexStatus.primaries.docs.count);

  // Validate destination index mappings are correct
  const fieldMappings = await esClient.indices.getMapping()
    .then((mappingsResponse) => mappingsResponse.body);

  const sourceMapping = get(fieldMappings, esIndex);
  const destMapping = get(fieldMappings, destIndex);

  t.deepEqual(sourceMapping.mappings, destMapping.mappings);

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Reindex - destination index exists', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName: indexAlias,
      destIndex: esIndex,
      sourceIndex: esIndex
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `Destination index ${esIndex} exists. Please specify an index name that does not exist.`);
});

test.serial('Reindex status, no task running', async (t) => {
  const response = await request(app)
    .get('/elasticsearch/reindex-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.deepEqual(response.body.reindexStatus, { nodes: {} });
});

test.serial('Change index - no current', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: indexAlias,
      newIndex: 'dest-index'
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Please explicity specify a current and new index.');
});

test.serial('Change index - no new', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: indexAlias,
      currentIndex: 'source-index'
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'Please explicity specify a current and new index.');
});

test.serial('Change index - current index does not exist', async (t) => {
  const currentIndex = 'source-index';

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: indexAlias,
      currentIndex,
      newIndex: 'dest-index'
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `Current index ${currentIndex} does not exist.`);
});

test.serial('Change index - new index does not exist', async (t) => {
  const newIndex = 'dest-index';

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: indexAlias,
      currentIndex: esIndex,
      newIndex
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, `New index ${newIndex} does not exist.`);
});

test.serial('Change index - current index same as new index', async (t) => {
  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName: indexAlias,
      currentIndex: 'source',
      newIndex: 'source'
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.body.message, 'The current index cannot be the same as the new index.');
});

test.serial('Change index', async (t) => {
  const sourceIndex = randomString();
  const aliasName = randomString();
  const destIndex = randomString();

  await createIndex(sourceIndex, aliasName);

  await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName,
      sourceIndex,
      destIndex
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName,
      currentIndex: sourceIndex,
      newIndex: destIndex
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message,
    `Reindex success - alias ${aliasName} now pointing to ${destIndex}`);

  const alias = await esClient.indices.getAlias({ name: aliasName })
    .then((aliasResponse) => aliasResponse.body);

  // Test that the only index connected to the alias is the destination index
  t.deepEqual(Object.keys(alias), [destIndex]);

  t.is((await esClient.indices.exists({ index: sourceIndex })).body, true);

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Change index and delete source index', async (t) => {
  const sourceIndex = randomString();
  const aliasName = randomString();
  const destIndex = randomString();

  await createIndex(sourceIndex, aliasName);

  await request(app)
    .post('/elasticsearch/reindex')
    .send({
      aliasName,
      sourceIndex,
      destIndex
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .post('/elasticsearch/change-index')
    .send({
      aliasName,
      currentIndex: sourceIndex,
      newIndex: destIndex,
      deleteSource: true
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message,
    `Reindex success - alias ${aliasName} now pointing to ${destIndex} and index ${sourceIndex} deleted`);
  t.is((await esClient.indices.exists({ index: sourceIndex })).body, false);

  await esClient.indices.delete({ index: destIndex });
});

test.serial('Reindex from database - create new index', async (t) => {
  const indexName = randomString();
  const id = randomString();

  sinon.stub(models.AsyncOperation.prototype, 'start').returns({ id });

  const response = await request(app)
    .post('/elasticsearch/index-from-database')
    .send({
      indexName
    })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.message,
    `Indexing database to ${indexName}. Operation id: ${id}`);

  const indexExists = await esClient.indices.exists({ index: indexName })
    .then((indexResponse) => indexResponse.body);

  t.true(indexExists);

  await esClient.indices.delete({ index: indexName });
  sinon.restore();
});

test.serial('Indices status', async (t) => {
  const indexName = `z-${randomString()}`;
  const otherIndexName = `a-${randomString()}`;

  await esClient.indices.create({
    index: indexName,
    body: { mappings }
  });

  await esClient.indices.create({
    index: otherIndexName,
    body: { mappings }
  });

  const response = await request(app)
    .get('/elasticsearch/indices-status')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.true(response.text.includes(indexName));
  t.true(response.text.includes(otherIndexName));

  await esClient.indices.delete({ index: indexName });
  await esClient.indices.delete({ index: otherIndexName });
});

test.serial('Current index - default alias', async (t) => {
  const indexName = randomString();
  await createIndex(indexName, defaultIndexAlias);

  const response = await request(app)
    .get('/elasticsearch/current-index')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.true(response.body.includes(indexName));

  await esClient.indices.delete({ index: indexName });
});

test.serial('Current index - custom alias', async (t) => {
  const indexName = randomString();
  const customAlias = randomString();
  await createIndex(indexName, customAlias);

  const response = await request(app)
    .get(`/elasticsearch/current-index/${customAlias}`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.deepEqual(response.body, [indexName]);

  await esClient.indices.delete({ index: indexName });
});
