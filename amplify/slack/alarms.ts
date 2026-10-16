import { Duration, Stack, Tags } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  alarmTags,
  alarmTopicSsmParameter,
  appIdLower,
  slackAlarmMaxErrorRatePercent,
  slackAlarmMinErrors,
  slackAlarmTagOverrides,
} from '../config';

// Must match the "event" field the teamSlackEvents Lambda logs (JSON) on a rejected signature
export const INVALID_SIGNATURE_LOG_EVENT = 'invalid_signature';

const PERIOD = Duration.minutes(5);
// Slack requires an answer within 3 s; alarm before that limit
const API_LATENCY_P99_THRESHOLD_MS = 2500;
const EVENTS_DURATION_P99_THRESHOLD_MS = 2000;
const INVALID_SIGNATURES_THRESHOLD = 10;

export interface SlackAlarmsProps {
  stack: Stack;
  env: string;
  api: apigateway.RestApi;
  eventsFunction: lambda.Function;
  workerFunction: lambda.Function;
  callbackFunction: lambda.Function;
}

/**
 * Creates CloudWatch alarms for the Slack integration.
 *
 * Alarms notify the SNS topic referenced by the ALARM_TOPIC_SSM_PARAMETER
 * SSM parameter. Without it the alarms are created without actions.
 * Error alarms fire only when both the error count and the error rate
 * exceed their thresholds, so they work at low and high traffic.
 * Every alarm gets ALARM_TAGS, overridden per alarm ID by SLACK_ALARM_TAG_OVERRIDES.
 *
 * @param props.stack - Dedicated CDK Stack for the Slack integration
 * @param props.env - Environment name (e.g., 'sandbox', 'prod')
 * @param props.api - Slack REST API
 * @param props.eventsFunction - Slack events Lambda (public entry point)
 * @param props.workerFunction - Slack worker Lambda (async)
 * @param props.callbackFunction - Slack OAuth callback Lambda
 */
export function createSlackAlarms(props: SlackAlarmsProps): void {
  const { stack, env, api, eventsFunction, workerFunction, callbackFunction } = props;

  const topic = alarmTopicSsmParameter
    ? sns.Topic.fromTopicArn(stack, 'AlarmTopic', ssm.StringParameter.valueForStringParameter(stack, alarmTopicSsmParameter))
    : undefined;

  const alarmIds = new Set<string>();
  const createAlarm = (id: string, alarmProps: Omit<cloudwatch.AlarmProps, 'evaluationPeriods'>): cloudwatch.Alarm => {
    alarmIds.add(id);
    const alarm = new cloudwatch.Alarm(stack, id, {
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: `teamSlack-${id}-${appIdLower}-${env}`,
      ...alarmProps,
    });
    if (topic) {
      alarm.addAlarmAction(new cwActions.SnsAction(topic));
      alarm.addOkAction(new cwActions.SnsAction(topic));
    }
    // Tags for alert routing (e.g. team, service, severity)
    const tags = { ...alarmTags, ...(slackAlarmTagOverrides[id] ?? {}) };
    Object.entries(tags).forEach(([key, value]) => Tags.of(alarm).add(key, value));
    return alarm;
  };

  // Returns 1 when errors >= min count AND error rate >= max rate, otherwise 0
  const errorRateBreach = (errors: cloudwatch.IMetric, total: cloudwatch.IMetric): cloudwatch.MathExpression => {
    const rate = new cloudwatch.MathExpression({
      expression: 'IF(total > 0, errors / total * 100, 0)',
      usingMetrics: { errors, total },
      period: PERIOD,
      label: 'Error rate (%)',
    });
    return new cloudwatch.MathExpression({
      expression: `IF(errors >= ${slackAlarmMinErrors} AND rate >= ${slackAlarmMaxErrorRatePercent}, 1, 0)`,
      usingMetrics: { errors, rate },
      period: PERIOD,
      label: 'Error threshold breached',
    });
  };

  const createErrorRateAlarm = (
    id: string,
    errors: cloudwatch.IMetric,
    total: cloudwatch.IMetric,
    what: string,
    check: string,
  ) =>
    createAlarm(id, {
      metric: errorRateBreach(errors, total),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: `${what} Fires when errors >= ${slackAlarmMinErrors} and error rate >= ${slackAlarmMaxErrorRatePercent}% in 5 minutes. ${check}`,
    });

  const sum = { statistic: 'Sum', period: PERIOD };

  // API Gateway
  createErrorRateAlarm(
    'ApiServerErrors',
    api.metricServerError(sum),
    api.metricCount(sum),
    'Slack API returns 5XX responses.',
    'Check the Lambda alarms and the Lambda and API access logs first.',
  );

  createAlarm('ApiLatency', {
    metric: api.metricLatency({ statistic: 'p99', period: PERIOD }),
    threshold: API_LATENCY_P99_THRESHOLD_MS,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    alarmDescription: `Slack API p99 latency above ${API_LATENCY_P99_THRESHOLD_MS} ms; Slack requires an answer within 3 s. Check the events Lambda duration and cold starts first.`,
  });

  // Lambda errors and throttles
  const lambdas: Array<[string, string, lambda.Function]> = [
    ['EventsErrors', 'Events', eventsFunction],
    ['WorkerErrors', 'Worker', workerFunction],
    ['CallbackErrors', 'OAuthCallback', callbackFunction],
  ];
  lambdas.forEach(([id, label, fn]) => {
    createErrorRateAlarm(
      id,
      fn.metricErrors(sum),
      fn.metricInvocations(sum),
      `The ${label} Lambda is failing.`,
      `Check the log group ${fn.logGroup.logGroupName} for stack traces first.`,
    );
  });

  const throttled: Array<[string, string, lambda.Function]> = [
    ['EventsThrottles', 'Events', eventsFunction],
    ['WorkerThrottles', 'Worker', workerFunction],
    ['CallbackThrottles', 'OAuthCallback', callbackFunction],
  ];
  throttled.forEach(([id, label, fn]) => {
    createAlarm(id, {
      metric: fn.metricThrottles(sum),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: `The ${label} Lambda was throttled. Check account and function concurrency limits first.`,
    });
  });

  // Worker async events dropped (expired or failed delivery with retries disabled)
  createAlarm('WorkerAsyncEventsDropped', {
    metric: new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'AsyncEventsDropped',
      dimensionsMap: { FunctionName: workerFunction.functionName },
      statistic: 'Sum',
      period: PERIOD,
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    alarmDescription: 'A user action was lost: the worker async event was dropped and async retries are 0. Check the worker errors and throttles first.',
  });

  // Events Lambda duration (Slack timeout is 3 s)
  createAlarm('EventsDuration', {
    metric: eventsFunction.metricDuration({ statistic: 'p99', period: PERIOD }),
    threshold: EVENTS_DURATION_P99_THRESHOLD_MS,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    alarmDescription: `Events Lambda p99 duration above ${EVENTS_DURATION_P99_THRESHOLD_MS} ms; Slack requires an answer within 3 s. Check cold starts and the SSM and worker invoke calls first.`,
  });

  // Rejected Slack signatures, counted from the events Lambda JSON logs
  const invalidSignatureMetricName = `InvalidSignatures-${appIdLower}-${env}`;
  new logs.MetricFilter(stack, 'InvalidSignatureFilter', {
    logGroup: eventsFunction.logGroup,
    filterPattern: logs.FilterPattern.stringValue('$.event', '=', INVALID_SIGNATURE_LOG_EVENT),
    metricNamespace: 'TEAM/Slack',
    metricName: invalidSignatureMetricName,
    metricValue: '1',
    defaultValue: 0,
  });

  createAlarm('InvalidSignatures', {
    metric: new cloudwatch.Metric({
      namespace: 'TEAM/Slack',
      metricName: invalidSignatureMetricName,
      statistic: 'Sum',
      period: PERIOD,
    }),
    threshold: INVALID_SIGNATURES_THRESHOLD,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    alarmDescription: 'Many rejected Slack signatures: forged requests or a wrong signing secret after rotation. Check the signing secret in the SSM parameter first.',
  });

  // Fail the build on typos in SLACK_ALARM_TAG_OVERRIDES
  const unknownIds = Object.keys(slackAlarmTagOverrides).filter(id => !alarmIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`SLACK_ALARM_TAG_OVERRIDES contains unknown alarm IDs: ${unknownIds.join(', ')}. Known IDs: ${[...alarmIds].join(', ')}`);
  }
}
