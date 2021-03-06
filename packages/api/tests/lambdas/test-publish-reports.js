'use strict';

const test = require('ava');
const rewire = require('rewire');
const sinon = require('sinon');
const pick = require('lodash.pick');

const aws = require('@cumulus/common/aws');
const { getMessageExecutionArn } = require('@cumulus/common/message');
const { ActivityStep, LambdaStep } = require('@cumulus/common/sfnStep');
const StepFunctions = require('@cumulus/common/StepFunctions');
const { randomId, randomNumber, randomString } = require('@cumulus/common/test-utils');

const { fakeExecutionFactoryV2, fakeFileFactory } = require('../../lib/testUtils');
const { deconstructCollectionId } = require('../../lib/utils');
const Execution = require('../../models/executions');
const Granule = require('../../models/granules');
const Pdr = require('../../models/pdrs');

const publishReports = rewire('../../lambdas/publish-reports');

let snsStub;
let executionPublishSpy;
let granulePublishSpy;
let pdrPublishSpy;
let snsPublishSpy;
let stepFunctionsStub;
let executionModel;

const sfEventSource = 'aws.states';

const createCloudwatchEventMessage = (
  status,
  message,
  source = sfEventSource
) => {
  const messageString = JSON.stringify(message);
  const detail = (status === 'SUCCEEDED'
    ? { status, output: messageString }
    : { status, input: messageString });
  return { source, detail };
};

const createFakeGranule = (granuleParams = {}, fileParams = {}) => ({
  granuleId: randomId('granule'),
  files: [
    fakeFileFactory(fileParams),
    fakeFileFactory(fileParams),
    fakeFileFactory(fileParams)
  ],
  ...granuleParams
});

const createCumulusMessage = ({
  numberOfGranules = 1,
  cMetaParams = {},
  collectionId = `${randomId('MOD')}___${randomNumber()}`,
  granuleParams = {},
  fileParams = {},
  pdrParams = {}
} = {}) => ({
  cumulus_meta: {
    execution_name: randomId('execution'),
    state_machine: randomId('ingest-'),
    ...cMetaParams
  },
  meta: {
    collection: deconstructCollectionId(collectionId),
    provider: {
      id: 'prov1',
      protocol: 'http',
      host: 'example.com',
      port: 443
    }
  },
  payload: {
    granules: [
      ...new Array(numberOfGranules)
    ].map(createFakeGranule.bind(null, { collectionId, ...granuleParams }, fileParams)),
    pdr: {
      name: randomString(),
      ...pdrParams
    }
  }
});

test.before(async () => {
  process.env.ExecutionsTable = randomString();

  snsStub = sinon.stub(aws, 'sns').returns({
    publish: () => ({
      promise: () => Promise.resolve()
    })
  });

  executionModel = new Execution();
  await executionModel.createTable();

  executionPublishSpy = sinon.spy();
  granulePublishSpy = sinon.spy();
  pdrPublishSpy = sinon.spy();
  snsPublishSpy = sinon.spy(aws.sns(), 'publish');
});

test.beforeEach((t) => {
  process.env.execution_sns_topic_arn = randomString();
  process.env.granule_sns_topic_arn = randomString();
  process.env.pdr_sns_topic_arn = randomString();

  t.context.snsTopicArns = [
    process.env.execution_sns_topic_arn,
    process.env.granule_sns_topic_arn,
    process.env.pdr_sns_topic_arn
  ];

  t.context.message = createCumulusMessage({
    numberOfGranules: 1
  });

  t.context.executionArn = getMessageExecutionArn(t.context.message);

  const fakeExecution = async () => ({
    startDate: new Date(Date.UTC(2019, 6, 28)),
    stopDate: new Date(Date.UTC(2019, 6, 28, 1))
  });
  stepFunctionsStub = sinon.stub(StepFunctions, 'describeExecution').callsFake(fakeExecution);

  executionPublishSpy.resetHistory();
  granulePublishSpy.resetHistory();
  pdrPublishSpy.resetHistory();
  snsPublishSpy.resetHistory();
});

test.afterEach.always(() => {
  stepFunctionsStub.restore();
});

test.after.always(async () => {
  snsStub.restore();
  await executionModel.deleteTable();
});

test.serial('lambda publishes report to all SNS topics', async (t) => {
  const { message, snsTopicArns } = t.context;

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  await publishReports.handler(cwEventMessage);

  t.is(snsPublishSpy.callCount, 3);
  t.true(snsTopicArns.includes(snsPublishSpy.args[0][0].TopicArn));
  t.true(snsTopicArns.includes(snsPublishSpy.args[1][0].TopicArn));
  t.true(snsTopicArns.includes(snsPublishSpy.args[2][0].TopicArn));
});

test.serial('lambda publishes correct execution record to SNS topic', async (t) => {
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const executionName = randomId('execution');
  const stateMachineArn = randomId('ingest-');
  const arn = aws.getExecutionArn(stateMachineArn, executionName);
  const createdAtTime = Date.now();

  const message = createCumulusMessage({
    cMetaParams: {
      execution_name: executionName,
      state_machine: stateMachineArn,
      workflow_start_time: createdAtTime
    }
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(executionPublishSpy.callCount, 1);
    // Ensure that the correct execution record is passed to publish handler
    const executionPublishRecord = executionPublishSpy.args[0][0];
    t.is(executionPublishRecord.arn, arn);
    t.is(executionPublishRecord.name, executionName);
    t.is(executionPublishRecord.status, 'running');
    t.is(executionPublishRecord.createdAt, createdAtTime);
  } finally {
    // revert the mocking
    executionPublishMock();
  }
});

test.serial('lambda publishes completed execution record to SNS topic', async (t) => {
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const executionName = randomId('execution');
  const stateMachineArn = randomId('ingest-');
  const arn = aws.getExecutionArn(stateMachineArn, executionName);
  const createdAtTime = Date.now();

  const message = createCumulusMessage({
    cMetaParams: {
      execution_name: executionName,
      state_machine: stateMachineArn,
      workflow_start_time: createdAtTime
    }
  });

  const failedCwEventMessage = createCloudwatchEventMessage(
    'SUCCEEDED',
    message
  );

  try {
    await executionModel.create({
      arn,
      name: executionName,
      status: 'running',
      createdAt: Date.now()
    });

    await publishReports.handler(failedCwEventMessage);

    t.is(executionPublishSpy.callCount, 1);
    // Ensure that the correct execution record is passed to publish handler
    const executionPublishRecord = executionPublishSpy.args[0][0];
    t.is(executionPublishRecord.status, 'completed');
  } finally {
    // revert the mocking
    executionPublishMock();
  }
});

test.serial('lambda publishes failed execution record to SNS topic', async (t) => {
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const executionName = randomId('execution');
  const stateMachineArn = randomId('ingest-');
  const arn = aws.getExecutionArn(stateMachineArn, executionName);
  const createdAtTime = Date.now();

  const message = createCumulusMessage({
    cMetaParams: {
      execution_name: executionName,
      state_machine: stateMachineArn,
      workflow_start_time: createdAtTime
    }
  });

  const failedCwEventMessage = createCloudwatchEventMessage(
    'FAILED',
    message
  );

  // Stub the failed step message, otherwise the ARN from the
  // failed execution input won't match the ARN in the message created
  // for this test.
  const getFailedStepStub = sinon.stub(LambdaStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(() => message);

  try {
    await executionModel.create({
      arn,
      name: executionName,
      status: 'running',
      createdAt: Date.now()
    });

    await publishReports.handler(failedCwEventMessage);

    t.is(executionPublishSpy.callCount, 1);
    // Ensure that the correct execution record is passed to publish handler
    const executionPublishRecord = executionPublishSpy.args[0][0];
    t.is(executionPublishRecord.arn, arn);
    t.is(executionPublishRecord.status, 'failed');
  } finally {
    // revert the mocking
    getFailedStepStub.restore();
    executionPublishMock();
  }
});

test.serial('lambda does not publish completed record for non-existent execution to SNS topic', async (t) => {
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const message = createCumulusMessage();

  const cwEventMessage = createCloudwatchEventMessage(
    'SUCCEEDED',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(executionPublishSpy.callCount, 0);
  } finally {
    // revert the mocking
    executionPublishMock();
  }
});

test.serial('lambda without granules in message does not publish to granule SNS topic', async (t) => {
  const { message } = t.context;

  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  delete message.payload.granules;

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(granulePublishSpy.callCount, 0);
  } finally {
    // revert the mocking
    granulePublishMock();
  }
});

test.serial('lambda ignores granules without granule ID', async (t) => {
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  const message = createCumulusMessage({
    numberOfGranules: 3
  });
  message.payload.granules.push({});

  t.is(message.payload.granules.length, 4);

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(granulePublishSpy.callCount, 3);
  } finally {
    // revert the mocking
    granulePublishMock();
  }
});

test.serial('failure describing step function in handleGranuleMessages does not prevent publishing to SNS topic', async (t) => {
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  stepFunctionsStub.restore();
  sinon.stub(StepFunctions, 'describeExecution').callsFake(() => {
    throw new Error('error');
  });

  const message = createCumulusMessage({
    numberOfGranules: 1
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await t.notThrowsAsync(
      () => publishReports.handler(cwEventMessage)
    );

    t.is(granulePublishSpy.callCount, 1);
  } finally {
    // revert the mocking
    granulePublishMock();
  }
});

test.serial('lambda publishes correct granules from payload.granules to SNS topic', async (t) => {
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  const collectionId = `${randomId('MOD')}___${randomNumber()}`;
  const executionName = randomId('execution');
  const createdAtTime = Date.now();
  const message = createCumulusMessage({
    numberOfGranules: 5,
    collectionId,
    cMetaParams: {
      execution_name: executionName,
      workflow_start_time: createdAtTime
    }
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.plan(6);
    t.is(granulePublishSpy.callCount, 5);

    // Ensure that correct granule records are actually being passed to publish handler
    granulePublishSpy.args
      .filter((args) => args[0].granuleId)
      .map(([granuleRecord]) => t.deepEqual(
        {
          ...pick(granuleRecord, ['collectionId', 'status', 'createdAt']),
          executionValid: granuleRecord.execution.includes(executionName)
        },
        {
          collectionId,
          status: 'running',
          createdAt: createdAtTime,
          executionValid: true
        }
      ));
  } finally {
    // revert the mocking
    granulePublishMock();
  }
});

test.serial('lambda without PDR in message does not publish to PDR SNS topic', async (t) => {
  const { message } = t.context;

  const pdrPublishMock = publishReports.__set__('publishPdrSnsMessage', pdrPublishSpy);

  delete message.payload.pdr;

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(pdrPublishSpy.callCount, 0);
  } finally {
    // revert the mocking
    pdrPublishMock();
  }
});

test.serial('lambda without valid PDR in message does not publish to PDR SNS topic', async (t) => {
  const { message } = t.context;

  const pdrPublishMock = publishReports.__set__('publishPdrSnsMessage', pdrPublishSpy);

  delete message.payload.pdr.name;

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(pdrPublishSpy.callCount, 0);
  } finally {
    // revert the mocking
    pdrPublishMock();
  }
});

test.serial('lambda publishes PDR from payload.pdr to SNS topic', async (t) => {
  const pdrPublishMock = publishReports.__set__('publishPdrSnsMessage', pdrPublishSpy);

  const pdrName = randomString();
  const pdrParams = {
    name: pdrName
  };
  const collectionId = `${randomId('MOD')}___${randomNumber()}`;
  const createdAtTime = Date.now();
  const message = createCumulusMessage({
    pdrParams,
    collectionId,
    cMetaParams: {
      workflow_start_time: createdAtTime
    }
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(pdrPublishSpy.callCount, 1);
    // Ensure that correct PDR record is passed to publish handler
    const publishPdrRecord = pdrPublishSpy.args[0][0];
    t.is(publishPdrRecord.pdrName, pdrName);
    t.is(publishPdrRecord.provider, message.meta.provider.id);
    t.is(publishPdrRecord.collectionId, collectionId);
    t.is(publishPdrRecord.status, 'running');
    t.is(publishPdrRecord.createdAt, createdAtTime);
  } finally {
    // revert the mocking
    pdrPublishMock();
  }
});

test.serial('error handling execution record does not affect publishing to other topics', async (t) => {
  const pdrPublishMock = publishReports.__set__('publishPdrSnsMessage', pdrPublishSpy);
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const { message } = t.context;

  const generateRecordStub = sinon.stub(Execution, 'generateRecord').callsFake(() => {
    throw new Error('error');
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(executionPublishSpy.callCount, 0);
    t.is(granulePublishSpy.callCount, 1);
    t.is(pdrPublishSpy.callCount, 1);
  } finally {
    // revert the mocking
    executionPublishMock();
    granulePublishMock();
    pdrPublishMock();
    generateRecordStub.restore();
  }
});

test.serial('error handling granule records does not affect publishing to other topics', async (t) => {
  const pdrPublishMock = publishReports.__set__('publishPdrSnsMessage', pdrPublishSpy);
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const { message } = t.context;

  const generateRecordStub = sinon.stub(Granule, 'generateGranuleRecord').callsFake(() => {
    throw new Error('error');
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(executionPublishSpy.callCount, 1);
    t.is(granulePublishSpy.callCount, 0);
    t.is(pdrPublishSpy.callCount, 1);
  } finally {
    // revert the mocking
    executionPublishMock();
    granulePublishMock();
    pdrPublishMock();
    generateRecordStub.restore();
  }
});

test.serial('error handling PDR record does not affect publishing to other topics', async (t) => {
  const pdrPublishMock = publishReports.__set__('publishPdrSnsMessage', pdrPublishSpy);
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);
  const executionPublishMock = publishReports.__set__('publishExecutionSnsMessage', executionPublishSpy);

  const { message } = t.context;

  const generateRecordStub = sinon.stub(Pdr, 'generatePdrRecord').callsFake(() => {
    throw new Error('error');
  });

  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  try {
    await publishReports.handler(cwEventMessage);

    t.is(executionPublishSpy.callCount, 1);
    t.is(granulePublishSpy.callCount, 1);
    t.is(pdrPublishSpy.callCount, 0);
  } finally {
    // revert the mocking
    executionPublishMock();
    granulePublishMock();
    pdrPublishMock();
    generateRecordStub.restore();
  }
});

test.serial('publish failure to executions topic does not affect publishing to other topics', async (t) => {
  // delete env var to cause failure publishing to executions topic
  delete process.env.execution_sns_topic_arn;

  const { message } = t.context;
  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  await publishReports.handler(cwEventMessage);

  t.is(snsPublishSpy.callCount, 2);
});

test.serial('publish failure to granules topic does not affect publishing to other topics', async (t) => {
  // delete env var to cause failure publishing to granules topic
  delete process.env.granule_sns_topic_arn;

  const { message } = t.context;
  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  await publishReports.handler(cwEventMessage);

  t.is(snsPublishSpy.callCount, 2);
});

test.serial('publish failure to PDRs topic does not affect publishing to other topics', async (t) => {
  // delete env var to cause failure publishing to PDRS topic
  delete process.env.pdr_sns_topic_arn;

  const { message } = t.context;
  const cwEventMessage = createCloudwatchEventMessage(
    'RUNNING',
    message
  );

  await publishReports.handler(cwEventMessage);

  t.is(snsPublishSpy.callCount, 2);
});

test.serial('handler publishes notification from input to first failed Lambda step in failed execution history', async (t) => {
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  const message = createCumulusMessage({ numberOfGranules: 1 });

  await executionModel.create(
    fakeExecutionFactoryV2({
      execution: message.cumulus_meta.execution_name,
      arn: aws.getExecutionArn(
        message.cumulus_meta.state_machine,
        message.cumulus_meta.execution_name
      )
    })
  );

  const cwEventMessage = createCloudwatchEventMessage('FAILED', message);

  const granuleId = randomId('granule');
  const failedStepInputMessage = createCumulusMessage({
    numberOfGranules: 2,
    granuleParams: {
      granuleId
    }
  });

  await executionModel.create(
    fakeExecutionFactoryV2({
      execution: failedStepInputMessage.cumulus_meta.execution_name,
      arn: aws.getExecutionArn(
        failedStepInputMessage.cumulus_meta.state_machine,
        failedStepInputMessage.cumulus_meta.execution_name
      )
    })
  );

  const getFailedLambdaStepStub = sinon.stub(LambdaStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(() => failedStepInputMessage);
  const getFailedActivityStepSpy = sinon.spy();
  const getFailedActivityStepStub = sinon.stub(ActivityStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(getFailedActivityStepSpy);

  try {
    await publishReports.handler(cwEventMessage);

    t.is(granulePublishSpy.callCount, 2);
    t.is(granulePublishSpy.args[0][0].granuleId, granuleId);
    t.is(granulePublishSpy.args[1][0].granuleId, granuleId);
    t.false(getFailedActivityStepSpy.called);
  } finally {
    // revert the mocking
    granulePublishMock();
    getFailedActivityStepStub.restore();
    getFailedLambdaStepStub.restore();
  }
});

test.serial('handler publishes notification from input to first failed Activity step in failed execution history', async (t) => {
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  const message = createCumulusMessage({ numberOfGranules: 1 });
  const cwEventMessage = createCloudwatchEventMessage('FAILED', message);

  await executionModel.create(
    fakeExecutionFactoryV2({
      execution: message.cumulus_meta.execution_name,
      arn: aws.getExecutionArn(
        message.cumulus_meta.state_machine,
        message.cumulus_meta.execution_name
      )
    })
  );

  const granuleId = randomId('granule');
  const failedStepInputMessage = createCumulusMessage({
    numberOfGranules: 2,
    granuleParams: {
      granuleId
    }
  });

  await executionModel.create(
    fakeExecutionFactoryV2({
      execution: failedStepInputMessage.cumulus_meta.execution_name,
      arn: aws.getExecutionArn(
        failedStepInputMessage.cumulus_meta.state_machine,
        failedStepInputMessage.cumulus_meta.execution_name
      )
    })
  );

  const getLambdaStepStub = sinon.stub(LambdaStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(() => undefined);
  const getActivityStepStub = sinon.stub(ActivityStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(() => failedStepInputMessage);

  try {
    await publishReports.handler(cwEventMessage);

    t.is(granulePublishSpy.callCount, 2);
    t.is(granulePublishSpy.args[0][0].granuleId, granuleId);
    t.is(granulePublishSpy.args[1][0].granuleId, granuleId);
  } finally {
    // revert the mocking
    granulePublishMock();
    getActivityStepStub.restore();
    getLambdaStepStub.restore();
  }
});

test.serial('handler publishes input to failed execution if failed step input cannot be retrieved', async (t) => {
  const granulePublishMock = publishReports.__set__('publishGranuleSnsMessage', granulePublishSpy);

  const granuleId = randomId('granule');
  const message = createCumulusMessage({
    numberOfGranules: 2,
    granuleParams: {
      granuleId
    }
  });

  await executionModel.create(
    fakeExecutionFactoryV2({
      execution: message.cumulus_meta.execution_name,
      arn: aws.getExecutionArn(
        message.cumulus_meta.state_machine,
        message.cumulus_meta.execution_name
      )
    })
  );

  const cwEventMessage = createCloudwatchEventMessage('FAILED', message);

  const getLambdaFailedStepStub = sinon.stub(LambdaStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(() => undefined);
  const getActivityFailedStepStub = sinon.stub(ActivityStep.prototype, 'getFirstFailedStepMessage')
    .callsFake(() => undefined);

  try {
    await publishReports.handler(cwEventMessage);

    t.is(granulePublishSpy.callCount, 2);
    t.is(granulePublishSpy.args[0][0].granuleId, granuleId);
    t.is(granulePublishSpy.args[1][0].granuleId, granuleId);
  } finally {
    // revert the mocking
    granulePublishMock();
    getActivityFailedStepStub.restore();
    getLambdaFailedStepStub.restore();
  }
});
