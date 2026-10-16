import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { fileURLToPath } from 'url';
import path from 'path';
import { appIdLower, idcIdentityProviderName } from '../../../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TeamSlackWorkerProps {
  stack: Stack;
  env: string;
  slackLayer: lambda.ILayerVersion;
  secretParameterArn: string;
  slackTeamId: string;
  graphqlUrl: string;
  userPoolId: string;
  slackClientId: string;
  cognitoBaseUrl: string;
  oauthCallbackUrl: string;
  linkStateTableName: string;
  userLinksTableName: string;
  kmsKeyArn: string;
}


export function createTeamSlackWorker(props: TeamSlackWorkerProps): lambda.Function {
  const { stack, env, slackLayer } = props;

  const functionName = `teamSlackWorker-${appIdLower}-${env}`;

  // Explicit log group so the alarms' metric filter can reference it at deploy time
  const logGroup = new logs.LogGroup(stack, 'TeamSlackWorkerLogGroup', {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const fn = new lambda.Function(stack, 'TeamSlackWorker', {
    functionName,
    logGroup,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname)),
    timeout: Duration.seconds(30),
    memorySize: 256,
    layers: [slackLayer],
    environment: {
      ENV: env,
      REGION: stack.region,
      SLACK_SECRET_PARAMETER_ARN: props.secretParameterArn,
      SLACK_TEAM_ID: props.slackTeamId,
      // Used as identity_provider in the account linking URL (skips the Cognito IdP selection)
      IDENTITY_PROVIDER_NAME: idcIdentityProviderName,
      GRAPHQL_URL: props.graphqlUrl,
      USER_POOL_ID: props.userPoolId,
      SLACK_CLIENT_ID: props.slackClientId,
      COGNITO_BASE_URL: props.cognitoBaseUrl,
      OAUTH_CALLBACK_URL: props.oauthCallbackUrl,
      LINK_STATE_TABLE: props.linkStateTableName,
      USER_LINKS_TABLE: props.userLinksTableName,
      KMS_KEY_ARN: props.kmsKeyArn,
    },
  });

  // Retries could create duplicate requests, so async invocations are never retried
  fn.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.seconds(60) });

  return fn;
}
