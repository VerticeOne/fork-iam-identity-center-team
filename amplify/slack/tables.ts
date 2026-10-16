import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { appIdLower, dynamoDbPitrEnabled, slackTokenKeyRotationDays } from '../config';

export interface SlackTablesProps {
  stack: Stack;
  env: string;
  dynamoDbKmsKeyArn?: string;
}

export interface SlackTablesOutput {
  tokenKey: kms.Key;
  linkStateTable: dynamodb.Table;
  userLinksTable: dynamodb.Table;
}

/**
 * Creates the KMS key and DynamoDB tables for Slack account linking.
 *
 * The tables use AWS managed encryption at rest unless a customer managed key
 * ARN is given (its key policy must delegate to IAM so the grants take effect); sensitive values are
 * additionally encrypted by the Lambdas with tokenKey before they are stored.
 *
 * @param props.stack - Dedicated CDK Stack for the Slack integration
 * @param props.env - Environment name (e.g., 'sandbox', 'prod')
 * @param props.dynamoDbKmsKeyArn - Optional customer managed KMS key for the tables
 * @returns Token key and tables
 */
export function createSlackTables(props: SlackTablesProps): SlackTablesOutput {
  const { stack, env, dynamoDbKmsKeyArn } = props;

  // Dedicated key, used only by Slack Lambdas to encrypt tokens before
  // storing them in DynamoDB. Default key policy (account root delegation to IAM).
  const tokenKey = new kms.Key(stack, 'SlackTokenKey', {
    alias: `alias/team-slack-tokens-${appIdLower}-${env}`,
    description: 'TEAM Slack integration: application-level encryption of user tokens',
    enableKeyRotation: true,
    rotationPeriod: Duration.days(slackTokenKeyRotationDays),
    removalPolicy: RemovalPolicy.DESTROY,
    pendingWindow: Duration.days(7),
  });

  // Imported key: table grants (grantReadWriteData etc.) also add the needed KMS permissions
  const tableEncryption = dynamoDbKmsKeyArn
    ? {
        encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: kms.Key.fromKeyArn(stack, 'SlackTablesKey', dynamoDbKmsKeyArn),
      }
    : { encryption: dynamodb.TableEncryption.AWS_MANAGED };

  // Pending account links; stores SHA-256 of the OAuth state and the
  // KMS-encrypted PKCE code_verifier
  const linkStateTable = new dynamodb.Table(stack, 'SlackLinkState', {
    tableName: `SlackLinkState-${appIdLower}-${env}`,
    partitionKey: { name: 'state_hash', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'expires_at',
    ...tableEncryption,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: dynamoDbPitrEnabled },
    removalPolicy: RemovalPolicy.DESTROY,
  });

  // Linked Slack users; the refresh token is stored only KMS-encrypted and
  // access tokens are never stored. expires_at TTL = refresh token expiry.
  const userLinksTable = new dynamodb.Table(stack, 'SlackUserLinks', {
    tableName: `SlackUserLinks-${appIdLower}-${env}`,
    partitionKey: { name: 'slack_user_id', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'expires_at',
    ...tableEncryption,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: dynamoDbPitrEnabled },
    removalPolicy: RemovalPolicy.DESTROY,
  });

  // Find links by TEAM user (e.g. admin disconnect); keys only, tokens are never projected
  userLinksTable.addGlobalSecondaryIndex({
    indexName: 'byCognitoUsername',
    partitionKey: { name: 'cognito_username', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY,
  });

  return { tokenKey, linkStateTable, userLinksTable };
}
