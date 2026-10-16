import { Duration, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { appIdLower, idcIdentityProviderName, slackAccessTokenValidityMinutes, slackRefreshTokenValidityDays } from '../config';

export interface SlackClientProps {
  stack: Stack;
  env: string;
  userPool: cognito.IUserPool;
  callbackUrl: string;
}

/**
 * Creates the confidential Cognito app client used to link Slack users.
 *
 * The SAML identity provider (idcIdentityProviderName) is created outside CDK (deployment/cognito.sh)
 * and must already exist in the user pool before this stack is enabled.
 * Trust with IAM Identity Center is pool-level, so no new IdC application is needed.
 *
 * @param props.stack - Dedicated CDK Stack for the Slack integration
 * @param props.env - Environment name (e.g., 'sandbox', 'prod')
 * @param props.userPool - Existing TEAM user pool
 * @param props.callbackUrl - OAuth callback URL of the Slack API
 * @returns The Cognito user pool client
 */
export function createSlackClient(props: SlackClientProps): cognito.UserPoolClient {
  const { stack, env, userPool, callbackUrl } = props;

  return new cognito.UserPoolClient(stack, 'SlackClient', {
    userPool,
    userPoolClientName: `teamAuth-slackClient-${appIdLower}-${env}`,
    generateSecret: true,
    // A non-empty authFlows object makes CDK emit only ALLOW_REFRESH_TOKEN_AUTH
    authFlows: { userPassword: false },
    oAuth: {
      flows: {
        authorizationCodeGrant: true,
        implicitCodeGrant: false,
        clientCredentials: false,
      },
      // Deliberately excludes aws.cognito.signin.user.admin
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      callbackUrls: [callbackUrl],
    },
    supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.custom(idcIdentityProviderName)],
    accessTokenValidity: Duration.minutes(slackAccessTokenValidityMinutes),
    idTokenValidity: Duration.minutes(slackAccessTokenValidityMinutes),
    refreshTokenValidity: Duration.days(slackRefreshTokenValidityDays),
    enableTokenRevocation: true,
    preventUserExistenceErrors: true,
    authSessionValidity: Duration.minutes(3),
  });
}
