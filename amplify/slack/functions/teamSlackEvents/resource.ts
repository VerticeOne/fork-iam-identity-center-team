import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { fileURLToPath } from 'url';
import path from 'path';
import { appIdLower } from '../../../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TeamSlackEventsProps {
  stack: Stack;
  env: string;
  slackLayer: lambda.ILayerVersion;
  secretArn: string;
  slackTeamId: string;
  slackAllowedUserIds: string;
  workerFunctionName: string;
}

/**
 * Public entry point: verifies the Slack signature and must answer within 3s.
 * Has no access to tokens or AppSync.
 */
export function createTeamSlackEvents(props: TeamSlackEventsProps): lambda.Function {
  const { stack, env, slackLayer } = props;

  const functionName = `teamSlackEvents-${appIdLower}-${env}`;

  // Explicit log group so the alarms' metric filter can reference it at deploy time
  const logGroup = new logs.LogGroup(stack, 'TeamSlackEventsLogGroup', {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const fn = new lambda.Function(stack, 'TeamSlackEvents', {
    functionName,
    logGroup,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.join(__dirname)),
    timeout: Duration.seconds(5),
    memorySize: 256,
    layers: [slackLayer],
    environment: {
      ENV: env,
      REGION: stack.region,
      SLACK_SECRET_ARN: props.secretArn,
      SLACK_TEAM_ID: props.slackTeamId,
      SLACK_ALLOWED_USER_IDS: props.slackAllowedUserIds,
      WORKER_FUNCTION_NAME: props.workerFunctionName,
    },
  });

  return fn;
}
