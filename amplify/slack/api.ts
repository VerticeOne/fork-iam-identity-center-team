import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { appIdLower } from '../config';

const STAGE_NAME = 'v1';

export interface SlackApiProps {
  stack: Stack;
  env: string;
  wafArn?: string;
}

export interface SlackApiOutput {
  api: apigateway.RestApi;
  eventsResource: apigateway.Resource;
  callbackResource: apigateway.Resource;
  callbackUrl: string;
}

export interface SlackApiRoutesProps {
  eventsResource: apigateway.IResource;
  callbackResource: apigateway.IResource;
  eventsFunction: lambda.IFunction;
  callbackFunction: lambda.IFunction;
}

/**
 * Creates the public REGIONAL REST API for the Slack integration.
 *
 * Creates the API, access logs, the resources /slack/events and
 * /slack/oauth/callback (without methods), the optional WAF association and
 * the outputs. Methods are added by addSlackApiRoutes once the Lambdas exist,
 * because the Lambdas need the callback URL and the API needs the Lambdas.
 *
 * @param props.stack - Dedicated CDK Stack for the Slack integration
 * @param props.env - Environment name (e.g., 'sandbox', 'prod')
 * @param props.wafArn - Optional WAF WebACL ARN to associate with the API stage
 * @returns The REST API, its resources and the OAuth callback URL
 */
export function createSlackApi(props: SlackApiProps): SlackApiOutput {
  const { stack, env, wafArn } = props;

  const logGroup = new logs.LogGroup(stack, 'SlackApiAccessLogs', {
    logGroupName: `/aws/apigateway/teamSlackApi-${appIdLower}-${env}`,
    retention: logs.RetentionDays.THREE_MONTHS,
    // DESTROY so the stack can be disabled and re-enabled without a log group name conflict
    removalPolicy: RemovalPolicy.DESTROY,
  });

  const api = new apigateway.RestApi(stack, 'SlackApi', {
    restApiName: `teamSlackApi-${appIdLower}-${env}`,
    description: 'TEAM Slack integration (events and OAuth callback)',
    endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
    // The account-level API Gateway CloudWatch role must already exist;
    // it is account-wide and must not be owned by this stack
    cloudWatchRole: false,
    deployOptions: {
      stageName: STAGE_NAME,
      throttlingRateLimit: 10,
      throttlingBurstLimit: 20,
      metricsEnabled: true,
      loggingLevel: apigateway.MethodLoggingLevel.OFF,
      // Slack payloads contain user data, never log request bodies
      dataTraceEnabled: false,
      accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
      // Never log the query string (OAuth code and state), headers or body (Slack signature, user data).
      // requestId correlates with the Lambda logs.
      accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
        requestId: apigateway.AccessLogField.contextRequestId(),
        requestTime: apigateway.AccessLogField.contextRequestTime(),
        httpMethod: apigateway.AccessLogField.contextHttpMethod(),
        resourcePath: apigateway.AccessLogField.contextResourcePath(),
        status: apigateway.AccessLogField.contextStatus(),
        responseLatency: apigateway.AccessLogField.contextResponseLatency(),
        integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
        integrationError: apigateway.AccessLogField.contextIntegrationErrorMessage(),
        errorMessage: apigateway.AccessLogField.contextErrorMessage(),
        wafStatus: apigateway.AccessLogField.contextWafStatus(),
        ip: apigateway.AccessLogField.contextIdentitySourceIp(),
        userAgent: apigateway.AccessLogField.contextIdentityUserAgent(),
      })),
    },
  });

  const slackResource = api.root.addResource('slack');
  const eventsResource = slackResource.addResource('events');
  const callbackResource = slackResource.addResource('oauth').addResource('callback');

  // Built from the API id and the fixed stage name instead of api.urlForPath(),
  // which references the stage resource and would create a dependency cycle
  // (Stage -> Deployment -> Methods -> Lambdas -> slackClient -> callback URL)
  const callbackUrl = `https://${api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/${STAGE_NAME}/slack/oauth/callback`;

  // WAF attaches to the REST API stage (ARN passed from Terraform via env var)
  if (wafArn) {
    const wafAssociation = new wafv2.CfnWebACLAssociation(stack, 'SlackApiWafAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: wafArn,
    });
    // stageArn is built from the API ID and stage name, so CloudFormation
    // would not wait for the stage without an explicit dependency
    wafAssociation.node.addDependency(api.deploymentStage);
  }

  new CfnOutput(stack, 'SlackEventsUrl', {
    value: api.urlForPath('/slack/events'),
    description: 'Slack app Request URL',
  });

  new CfnOutput(stack, 'SlackOAuthCallbackUrl', {
    value: api.urlForPath('/slack/oauth/callback'),
    description: 'Cognito slackClient callback URL',
  });

  return { api, eventsResource, callbackResource, callbackUrl };
}

/**
 * Wires the Slack API resources to their Lambdas.
 *
 * - POST /slack/events (slash commands, interactions, shortcuts)
 * - GET /slack/oauth/callback (redirect from Cognito after account linking)
 */
export function addSlackApiRoutes(props: SlackApiRoutesProps): void {
  const { eventsResource, callbackResource, eventsFunction, callbackFunction } = props;

  eventsResource.addMethod('POST', new apigateway.LambdaIntegration(eventsFunction));
  callbackResource.addMethod('GET', new apigateway.LambdaIntegration(callbackFunction));
}
