# © 2024 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
# This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
# http: // aws.amazon.com/agreement or other written agreement between Customer and either
# Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
import os
import botocore
from botocore.config import Config
from botocore.exceptions import ClientError
import boto3

team_admin_group = os.getenv("TEAM_ADMIN_GROUP")
team_auditor_group = os.getenv("TEAM_AUDITOR_GROUP")
settings_table_ssm_path = os.getenv("SETTINGS_TABLE_SSM_PATH")

dynamodb = boto3.resource('dynamodb')
ssm_client = boto3.client('ssm')

# Retries must fit into Cognito's 5 second trigger timeout
identitystore_config = Config(
    retries={"mode": "standard", "max_attempts": 3},
    connect_timeout=1,
    read_timeout=2,
)
identitystore_client = boto3.client('identitystore', config=identitystore_config)

settings_table = None

stale_data_warning = None

# Cold start: get Settings table name from SSM
try:
    response = ssm_client.get_parameter(Name=settings_table_ssm_path)
    settings_table_name = response['Parameter']['Value']
    settings_table = dynamodb.Table(settings_table_name)
except ClientError as e:
    stale_data_warning = f"WARNING: Failed to get SSM parameter {settings_table_ssm_path}: {e}. Using env variables for groups."
    print(stale_data_warning)


def get_settings():
    """Get settings from DynamoDB"""
    if settings_table is None:
        return {}

    response = settings_table.get_item(
        Key={
            'id': 'settings'
        }
    )
    return response

def get_team_groups():
    try:
        settings = get_settings()
        if not settings:
            print(stale_data_warning)
        item_settings = settings.get("Item", {})
        team_admin_group = item_settings.get("teamAdminGroup", os.getenv("TEAM_ADMIN_GROUP"))
        team_auditor_group = item_settings.get("teamAuditorGroup", os.getenv("TEAM_AUDITOR_GROUP"))
    except Exception as e:
        print(f"Error retrieving TEAM settings from database: {e}")
    return team_admin_group, team_auditor_group


def get_identity_store_id():
    client = boto3.client('sso-admin')
    try:
        response = client.list_instances()
        return response['Instances'][0]['IdentityStoreId']
    except ClientError as e:
        print(e.response['Error']['Message'])


sso_instance = get_identity_store_id()


def get_user(username):
    try:
        response = identitystore_client.get_user_id(
            IdentityStoreId=sso_instance,
            AlternateIdentifier={
                'UniqueAttribute': {
                    'AttributePath': 'userName',
                    'AttributeValue': username
                },
            }
        )
        return response['UserId']
    except ClientError as e:
        print(e.response['Error']['Message'])
        if e.response['Error']['Code'] == 'ResourceNotFoundException':
            return None
        # Fail closed: any other IdC error must not result in a token
        raise


def get_user_status(user_id):
    response = identitystore_client.describe_user(
        IdentityStoreId=sso_instance,
        UserId=user_id
    )
    status = response.get("UserStatus")
    if status is None:
        print(f"ERROR: UserStatus is missing from DescribeUser response (requires botocore >= 1.40.68), botocore version: {botocore.__version__}")
    return status.lower() if status else None


def get_group(group):
    try:
        response = identitystore_client.get_group_id(
            IdentityStoreId=sso_instance,
            AlternateIdentifier={
                'UniqueAttribute': {
                    'AttributePath': 'DisplayName',
                    'AttributeValue': group
                }
            }
        )
        return response['GroupId']
    except ClientError as e:
        print(e.response['Error']['Message'])

# Paginate

def list_idc_group_membership(userId):
    try:
        p = identitystore_client.get_paginator('list_group_memberships_for_member')
        paginator = p.paginate(IdentityStoreId=sso_instance,
            MemberId={
                'UserId': userId
            })
        all_groups = []
        for page in paginator:
            all_groups.extend(page["GroupMemberships"])
        return all_groups
    except ClientError as e:
        print(e.response['Error']['Message'])


def handler(event, context):
    team_admin_group, team_auditor_group = get_team_groups()

    user = event["userName"].split("_", 1)[1]
    userId = get_user(user)
    trigger_source = event.get("triggerSource")
    if not userId:
        print(f"User {user} not found in IAM Identity Center, triggerSource: {trigger_source}")
        raise Exception("Access denied")

    status = get_user_status(userId)
    if status != "enabled" and status:
        print(f"User {user} ({userId}) is {status.upper() if status else None} in IAM Identity Center, triggerSource: {trigger_source}")
        raise Exception("Access denied")

    admin = get_group(team_admin_group)
    auditor = get_group(team_auditor_group)
    groups = []
    groupIds = str()

    groupData = list_idc_group_membership(userId)

    for group in groupData:
        groupIds += group["GroupId"] + ","
        if group["GroupId"] == admin:
            # add_user_to_group(user, "Admin")
            groups.append("Admin")
        elif group["GroupId"] == auditor:
            # add_user_to_group(user, "Auditors")
            groups.append("Auditors")

    event["response"] = {
        "claimsOverrideDetails": {
            "claimsToAddOrOverride": {
                "userId": userId,
                "groupIds": groupIds,
                "groups": ",".join(groups)
            },
            "groupOverrideDetails": {
                "groupsToOverride": groups,
            },
        }
    }

    return event
