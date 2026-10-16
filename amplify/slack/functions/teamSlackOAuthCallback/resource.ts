import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { fileURLToPath } from 'url';
import path from 'path';
import { appIdLower } from '../../../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TeamSlackOAuthCallbackProps {
  stack: Stack;
  env: string;
  slackLayer: lambda.ILayerVersion;
  secretArn: string;
  slackTeamId: string;
  userPoolId: string;
  slackClientId: string;
  cognitoBaseUrl: string;
  oauthCallbackUrl: string;
  linkStateTableName: string;
  userLinksTableName: string;
  kmsKeyArn: string;
}


export function createTeamSlackOAuthCallback(props: TeamSlackOAuthCallbackProps): lambda.Function {
  const { stack, env, slackLayer } = props;

  const functionName = `teamSlackOAuthCallback-${appIdLower}-${env}`;

  // Explicit log group so the alarms' metric filter can reference it at deploy time
  const logGroup = new logs.LogGroup(stack, 'TeamSlackOAuthCallbackLogGroup', {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const fn = new lambda.Function(stack, 'TeamSlackOAuthCallback', {
    functionName,
    logGroup,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname)),
    timeout: Duration.seconds(10),
    memorySize: 256,
    layers: [slackLayer],
    environment: {
      ENV: env,
      REGION: stack.region,
      SLACK_SECRET_ARN: props.secretArn,
      SLACK_TEAM_ID: props.slackTeamId,
      USER_POOL_ID: props.userPoolId,
      SLACK_CLIENT_ID: props.slackClientId,
      COGNITO_BASE_URL: props.cognitoBaseUrl,
      OAUTH_CALLBACK_URL: props.oauthCallbackUrl,
      LINK_STATE_TABLE: props.linkStateTableName,
      USER_LINKS_TABLE: props.userLinksTableName,
      KMS_KEY_ARN: props.kmsKeyArn,
    },
  });

  return fn;
}
