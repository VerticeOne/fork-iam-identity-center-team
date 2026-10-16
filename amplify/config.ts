// Shared configuration for Amplify backend
// AWS_APP_ID is required - set by Amplify Hosting CI/CD or manually before deploy

export const appId = process.env.AWS_APP_ID;
if (!appId) {
    throw new Error('AWS_APP_ID environment variable is required. Create Amplify app first and export the ID.');
}
export const appIdLower = appId.toLowerCase();
export const branchName = process.env.AWS_BRANCH ?? 'sandbox';

// App URL for email links
// Uses custom domain if set, otherwise falls back to default Amplify URL
const customDomain = process.env.AMPLIFY_CUSTOM_DOMAIN;
const defaultAppUrl = `https://${branchName}.${appIdLower}.amplifyapp.com`;
export const appUrl = customDomain ? `https://${customDomain}` : defaultAppUrl;

// SSM parameter path for Settings table name (used by preToken Lambda)
export const settingsTableSsmPath = `/team/${appIdLower}/${branchName}/settings-table-name`;

// Cache TTL in seconds (default 7 days = 604800 seconds)
export const cacheTtl = parseInt(process.env.CACHE_TTL ?? '604800', 10);

// Pre-warm interval in days (default 1 day for testing, use 6 for production)
export const prewarmIntervalDays = parseInt(process.env.PREWARM_INTERVAL_DAYS ?? '1', 10);

// Compliance settings (default enabled)
export const s3VersioningEnabled = (process.env.S3_VERSIONING_ENABLED ?? 'true') === 'true';
export const dynamoDbPitrEnabled = (process.env.DYNAMODB_PITR_ENABLED ?? 'true') === 'true';

// WAF ARN for AppSync (optional, passed from Terraform)
export const appSyncWafArn = process.env.APPSYNC_WAF_WEB_ACL_ARN;

// Name of the SAML identity provider (IAM Identity Center) in the Cognito user pool.
// Must match deployment/cognito.sh (--provider-name) and src/App.js (signInWithRedirect).
export const idcIdentityProviderName = 'IDC';

// Slack integration (optional, passed from Terraform)
// SLACK_SECRET_ARN enables the whole Slack integration stack
export const slackSecretArn = process.env.SLACK_SECRET_ARN;
export const slackApiWafArn = process.env.SLACK_API_WAF_WEB_ACL_ARN;
export const slackTeamId = process.env.SLACK_TEAM_ID ?? '';
// Comma-separated Slack user IDs allowed to use the integration; empty = everyone
export const slackAllowedUserIds = process.env.SLACK_ALLOWED_USER_IDS ?? '';
// Token validity for the Cognito slackClient
export const slackAccessTokenValidityMinutes = parseInt(process.env.SLACK_ACCESS_TOKEN_VALIDITY_MINUTES ?? '15', 10);
export const slackRefreshTokenValidityDays = parseInt(process.env.SLACK_REFRESH_TOKEN_VALIDITY_DAYS ?? '5', 10);

// Rotation period of the KMS key encrypting Slack user tokens (default: 365 days, KMS default)
export const slackTokenKeyRotationDays = parseInt(process.env.SLACK_TOKEN_KEY_ROTATION_DAYS ?? '365', 10);

// Optional customer managed KMS key for Slack DynamoDB tables (default: AWS managed)
export const slackDynamoDbKmsKeyArn = process.env.SLACK_DYNAMODB_KMS_KEY_ARN;
// Optional customer managed KMS key used by Terraform to encrypt the Slack secret (default: aws/secretsmanager)
export const slackSecretKmsKeyArn = process.env.SLACK_SECRET_KMS_KEY_ARN;

// SSM parameter holding the ARN of the SNS topic for CloudWatch alarms (optional; without it alarms have no actions)
export const alarmTopicSsmParameter = process.env.ALARM_TOPIC_SSM_PARAMETER;
function parseJsonEnv(name: string, value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`${name} is not valid JSON`);
    }
}

function isStringMap(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.values(value).every(v => typeof v === 'string');
}

// Tags added to every CloudWatch alarm, as a JSON object of strings (optional), e.g.
// {"vertice:teams":"Team Peach","vertice:service":"data-visualizer","vertice:severity":"warning"}
function parseAlarmTags(value: string | undefined): Record<string, string> {
    if (!value) {
        return {};
    }
    const parsed = parseJsonEnv('ALARM_TAGS', value);
    if (!isStringMap(parsed)) {
        throw new Error('ALARM_TAGS must be a JSON object with string values');
    }
    return parsed;
}
export const alarmTags = parseAlarmTags(process.env.ALARM_TAGS);

// Per-alarm tag overrides for the Slack alarms, keyed by alarm ID (optional), e.g.
// {"ApiServerErrors":{"vertice:severity":"critical"}}; unknown alarm IDs fail the build
function parseAlarmTagOverrides(value: string | undefined): Record<string, Record<string, string>> {
    if (!value) {
        return {};
    }
    const parsed = parseJsonEnv('SLACK_ALARM_TAG_OVERRIDES', value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
        || !Object.values(parsed).every(isStringMap)) {
        throw new Error('SLACK_ALARM_TAG_OVERRIDES must be a JSON object of alarm IDs to JSON objects with string values');
    }
    return parsed as Record<string, Record<string, string>>;
}
export const slackAlarmTagOverrides = parseAlarmTagOverrides(process.env.SLACK_ALARM_TAG_OVERRIDES);
// Slack alarm thresholds: alarm when errors >= min count AND error rate >= max rate (works at low and high traffic)
export const slackAlarmMinErrors = parseInt(process.env.SLACK_ALARM_MIN_ERRORS ?? '3', 10);
export const slackAlarmMaxErrorRatePercent = parseFloat(process.env.SLACK_ALARM_MAX_ERROR_RATE_PERCENT ?? '5');

// Validate Slack settings only when the integration is enabled (Cognito limits apply)
if (slackSecretArn) {
    if (!slackTeamId) {
        throw new Error('SLACK_TEAM_ID must be set when SLACK_SECRET_ARN is set');
    }
    if (!Number.isInteger(slackAccessTokenValidityMinutes) || slackAccessTokenValidityMinutes < 5 || slackAccessTokenValidityMinutes > 1440) {
        throw new Error('SLACK_ACCESS_TOKEN_VALIDITY_MINUTES must be an integer between 5 and 1440');
    }
    if (!Number.isInteger(slackRefreshTokenValidityDays) || slackRefreshTokenValidityDays < 1 || slackRefreshTokenValidityDays > 3650) {
        throw new Error('SLACK_REFRESH_TOKEN_VALIDITY_DAYS must be an integer between 1 and 3650');
    }
    if (!Number.isInteger(slackTokenKeyRotationDays) || slackTokenKeyRotationDays < 90 || slackTokenKeyRotationDays > 2560) {
        throw new Error('SLACK_TOKEN_KEY_ROTATION_DAYS must be an integer between 90 and 2560');
    }
    if (!Number.isInteger(slackAlarmMinErrors) || slackAlarmMinErrors < 1) {
        throw new Error('SLACK_ALARM_MIN_ERRORS must be an integer >= 1');
    }
    if (!Number.isFinite(slackAlarmMaxErrorRatePercent) || slackAlarmMaxErrorRatePercent <= 0 || slackAlarmMaxErrorRatePercent > 100) {
        throw new Error('SLACK_ALARM_MAX_ERROR_RATE_PERCENT must be a number greater than 0 and at most 100');
    }
}
