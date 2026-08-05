import { Duration, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { fileURLToPath } from 'url';
import path from 'path';
import { appIdLower } from '../../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TeamgetEntitlementProps {
    stack: Stack;
    env: string;
    eligibilityTableName: string;
    policiesTableName: string;
    settingsTableName: string;
    cacheTableName: string;
    cacheTtl?: number;
    graphqlApiEndpoint: string;
    graphqlApiId: string;
    sharedPythonLayer: lambda.ILayerVersion;
}

export function createTeamgetEntitlement(props: TeamgetEntitlementProps): lambda.Function {
    const { stack, env, eligibilityTableName, policiesTableName, settingsTableName, cacheTableName, graphqlApiEndpoint, graphqlApiId, sharedPythonLayer } = props;
    const cacheTtl = props.cacheTtl ?? 604800;

    const fn = new lambda.Function(stack, 'TeamgetEntitlement', {
        functionName: `teamgetEntitlement-${appIdLower}-${env}`,
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname)),
        timeout: Duration.seconds(300),
        memorySize: 256,
        layers: [sharedPythonLayer],
        environment: {
            ENV: env,
            REGION: stack.region,
            ACCOUNT_ID: stack.account,
            API_TEAM_GRAPHQLAPIENDPOINTOUTPUT: graphqlApiEndpoint,
            POLICY_TABLE_NAME: eligibilityTableName,
            POLICIES_TABLE_NAME: policiesTableName,
            SETTINGS_TABLE_NAME: settingsTableName,
            CACHE_TABLE_NAME: cacheTableName,
            CACHE_TTL: cacheTtl.toString(),
        },
    });

    fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan'],
        resources: [
            stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: eligibilityTableName }),
            stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: policiesTableName }),
            stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: settingsTableName }),
        ],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [
            stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: cacheTableName }),
        ],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['organizations:DescribeOrganization', 'organizations:ListAccountsForParent'],
        resources: ['*'],
    }));

    fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: [`arn:aws:appsync:${stack.region}:${stack.account}:apis/${graphqlApiId}/*`],
    }));

    return fn;
}
