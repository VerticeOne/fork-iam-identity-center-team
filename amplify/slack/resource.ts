import { Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { slackAllowedUserIds, slackTeamId } from '../config';
import { createSlackAlarms } from './alarms';
import { addSlackApiRoutes, createSlackApi } from './api';
import { createSlackClient } from './cognito';
import { createSlackPythonLayer } from './layer/resource';
import { createSlackTables } from './tables';
import { createTeamSlackEvents } from './functions/teamSlackEvents/resource';
import { createTeamSlackWorker } from './functions/teamSlackWorker/resource';
import { createTeamSlackOAuthCallback } from './functions/teamSlackOAuthCallback/resource';

export interface SlackIntegrationProps {
  stack: Stack;
  env: string;
  wafArn?: string;
  secretParameterArn: string;
  userPool: cognito.IUserPool;
  cognitoBaseUrl: string;
  graphqlUrl: string;
  dynamoDbKmsKeyArn?: string;
  secretKmsKeyArn?: string;
}

export interface SlackIntegrationOutput {
  api: apigateway.RestApi;
  slackClient: cognito.UserPoolClient;
  tokenKey: kms.Key;
  linkStateTable: dynamodb.Table;
  userLinksTable: dynamodb.Table;
  eventsFunction: lambda.Function;
  workerFunction: lambda.Function;
  callbackFunction: lambda.Function;
}

/**
 * Creates the optional Slack integration in its own stack.
 *
 * Nothing in the auth or data stacks references these resources, so the
 * dependency is one-way and the whole stack can be enabled or disabled.
 *
 * @param props.stack - Dedicated CDK Stack for the Slack integration
 * @param props.env - Environment name (e.g., 'sandbox', 'prod')
 * @param props.wafArn - Optional WAF WebACL ARN for the Slack API
 * @param props.secretParameterArn - ARN of the SSM SecureString parameter with the Slack credentials JSON
 * @param props.userPool - Existing TEAM Cognito user pool
 * @param props.cognitoBaseUrl - Base URL of the user pool domain (https://<prefix>.auth.<region>.amazoncognito.com)
 * @param props.graphqlUrl - AppSync GraphQL endpoint URL
 * @param props.dynamoDbKmsKeyArn - Optional customer managed KMS key for the tables
 * @param props.secretKmsKeyArn - Optional customer managed KMS key encrypting the SSM parameter (default: aws/ssm)
 * @returns Slack integration resources
 */
export function createSlackIntegration(props: SlackIntegrationProps): SlackIntegrationOutput {
  const { stack, env, wafArn, secretParameterArn, userPool, cognitoBaseUrl, graphqlUrl, dynamoDbKmsKeyArn, secretKmsKeyArn } = props;

  const { tokenKey, linkStateTable, userLinksTable } = createSlackTables({ stack, env, dynamoDbKmsKeyArn });
  const slackLayer = createSlackPythonLayer({ stack, env });
  const { api, eventsResource, callbackResource, callbackUrl } = createSlackApi({ stack, env, wafArn });
  const slackClient = createSlackClient({ stack, env, userPool, callbackUrl });

  const common = { stack, env, slackLayer, secretParameterArn, slackTeamId };
  const linking = {
    userPoolId: userPool.userPoolId,
    slackClientId: slackClient.userPoolClientId,
    cognitoBaseUrl,
    oauthCallbackUrl: callbackUrl,
    linkStateTableName: linkStateTable.tableName,
    userLinksTableName: userLinksTable.tableName,
    kmsKeyArn: tokenKey.keyArn,
  };

  const workerFunction = createTeamSlackWorker({ ...common, ...linking, graphqlUrl });
  const eventsFunction = createTeamSlackEvents({
    ...common,
    slackAllowedUserIds,
    workerFunctionName: workerFunction.functionName,
  });
  const callbackFunction = createTeamSlackOAuthCallback({ ...common, ...linking });

  // Slack app credentials (signing secret, bot token): readable by all three Lambdas
  [eventsFunction, workerFunction, callbackFunction].forEach(fn => {
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [secretParameterArn],
    }));
    // With the AWS managed aws/ssm key no KMS permission is needed; a customer managed key needs kms:Decrypt
    if (secretKmsKeyArn) {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [secretKmsKeyArn],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
      }));
    }
  });

  // Events only hands work to the worker; no table, KMS or Cognito access
  workerFunction.grantInvoke(eventsFunction);

  // Worker: reads links and tokens, writes pending link state
  userLinksTable.grantReadWriteData(workerFunction);
  linkStateTable.grantWriteData(workerFunction);

  // Callback: consumes the pending state and stores the new link
  linkStateTable.grantReadWriteData(callbackFunction);
  userLinksTable.grantWriteData(callbackFunction);

  // Token key usable only with a per-user encryption context, restricted by purpose:
  // the public callback can store tokens but never decrypt them
  const tokenKeyStatement = (action: string, purposes: string[]) => new iam.PolicyStatement({
    actions: [action],
    resources: [tokenKey.keyArn],
    conditions: {
      Null: { 'kms:EncryptionContext:slack_user_id': 'false' },
      StringEquals: { 'kms:EncryptionContext:purpose': purposes },
    },
  });
  workerFunction.addToRolePolicy(tokenKeyStatement('kms:Encrypt', ['code_verifier', 'access_token']));
  workerFunction.addToRolePolicy(tokenKeyStatement('kms:Decrypt', ['refresh_token', 'access_token']));
  callbackFunction.addToRolePolicy(tokenKeyStatement('kms:Encrypt', ['refresh_token', 'access_token']));
  callbackFunction.addToRolePolicy(tokenKeyStatement('kms:Decrypt', ['code_verifier']));

  // Read the slackClient secret at runtime instead of putting it in env/CloudFormation
  [workerFunction, callbackFunction].forEach(fn => {
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [userPool.userPoolArn],
    }));
  });

  // No Lambda gets appsync permissions: the worker calls AppSync only with the user's own JWT

  addSlackApiRoutes({ eventsResource, callbackResource, eventsFunction, callbackFunction });

  createSlackAlarms({ stack, env, api, eventsFunction, workerFunction, callbackFunction });

  return {
    api,
    slackClient,
    tokenKey,
    linkStateTable,
    userLinksTable,
    eventsFunction,
    workerFunction,
    callbackFunction,
  };
}
