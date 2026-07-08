---
description: Complete deployment verification and Cognito/IAM Identity Center configuration for TEAM app. Use after Amplify deploy, new Cognito pool, or first-time setup.
---

# TEAM App Deployment Check & Configuration

Complete deployment verification and Cognito/IAM Identity Center configuration for TEAM app.

## When to Use

- After Amplify infrastructure deploy (Terraform)
- After Amplify app redeploy that created new Cognito pool
- To verify TEAM app is fully configured and working
- First-time TEAM app setup

## Initial Setup - Credentials

Before starting, ask the user for:

```
1. AWS CLI profile to use for TEAM account
   
2. AWS region (default: eu-west-1)

3. Branch name (default: main)
   Note: Scripts have "main" hardcoded. For other branches, 
   the skill will temporarily modify scripts before running.
```

**Ask the user to authenticate first:**

```
Please run: ! assume <profile-name>
```

Or if not using `assume` (granted):
```
Please run: ! aws sso login --profile <profile-name>
```

The `!` prefix runs the command in this session so credentials are available.

### Variables used in all commands

```bash
AWS_PROFILE="<user-provided-profile>"
AWS_REGION="<user-provided-region>"
BRANCH_NAME="<user-provided-branch>"  # default: main
TEAM_REPO="<path-to-team-repo>"
```

**Important:** All AWS CLI commands must include:
- `--profile "$AWS_PROFILE"` 
- `--region "$AWS_REGION"`
- `--output json` (AWS CLI may default to YAML which breaks jq parsing)

## Process Overview

```
1. Ask user for credentials and assume role
2. Check Terraform Amplify resources exist (optional)
3. Check Amplify app is deployed and running
4. Check Cognito User Pool exists
5. Check IAM Identity Center application exists
6. Configure parameters.sh and details.json
7. Run integration.sh → get SAML URLs
8. Update IAM Identity Center application (if needed, manual in console)
9. Run cognito.sh → configure Cognito IDC provider
10. Verify Cognito configuration
11. Test login flow
12. Present final summary
```

---

## Step 1: Check Terraform Infrastructure

### Ask user for Terraform repo details

```
Questions:
- Path to Terraform/Terragrunt repo
- Terragrunt unit path (relative path to the unit containing TEAM app module)
```

### Verify Amplify module is applied

```bash
cd <terraform-repo>/<terragrunt-unit>
terragrunt output -json | jq '.team_app_id.value, .team_app_arn.value, .team_app_default_domain.value'
```

Expected: Amplify App ID, ARN, and default domain

### Get configuration values from Terraform

```bash
# From terragrunt.hcl inputs
grep -A20 "team_app = {" terragrunt.hcl

# From account.hcl
cat ../../account.hcl | grep -E "account_id|region"
```

---

## Step 2: Check Amplify App Deployment

### Verify app exists in AWS

```bash
aws amplify list-apps --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq '.apps[] | select(.name=="TEAM-IDC-APP") | {name, appId, defaultDomain, repository}'
```

### Check branch deployment status

```bash
APP_ID=$(aws amplify list-apps --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq -r '.apps[] | select(.name=="TEAM-IDC-APP") | .appId')

aws amplify list-branches --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --app-id $APP_ID | jq '.branches[] | {branchName, stage, displayName, activeJobId}'

# Check last job status
aws amplify list-jobs --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --app-id $APP_ID --branch-name main --max-results 1 | jq '.jobSummaries[0] | {status, startTime, endTime}'
```

Expected: Branch exists, last job status is `SUCCEED`

### Get actual Amplify URL

```bash
# Default domain
DEFAULT_DOMAIN=$(aws amplify list-apps --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq -r '.apps[] | select(.name=="TEAM-IDC-APP") | .defaultDomain')
echo "Default URL: https://main.$DEFAULT_DOMAIN"

# Custom domain (if configured)
aws amplify list-domain-associations --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --app-id $APP_ID | jq '.domainAssociations[] | {domainName, domainStatus, subDomains}'
```

**Save this URL** - needed for verifying Cognito callback URLs later.

---

## Step 3: Check Cognito User Pool

```bash
aws cognito-idp list-user-pools --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --max-results 10 | jq '.UserPools[] | select(.Name | contains("teamAuth")) | {Id, Name, CreationDate}'
```

Expected: User pool with name containing "teamAuth"

### Get User Pool details

```bash
POOL_ID=$(aws cognito-idp list-user-pools --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --max-results 10 | jq -r '.UserPools[] | select(.Name | contains("teamAuth")) | .Id' | head -1)

# Domain
aws cognito-idp describe-user-pool --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --user-pool-id $POOL_ID | jq '.UserPool.Domain'

# App clients
aws cognito-idp list-user-pool-clients --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --user-pool-id $POOL_ID | jq '.UserPoolClients[] | {ClientId, ClientName}'
```

---

## Step 4: Check IAM Identity Center Application

```bash
# Get Identity Center instance ARN
INSTANCE_ARN=$(aws sso-admin list-instances --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq -r '.Instances[0].InstanceArn')

# List applications
aws sso-admin list-applications --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --instance-arn $INSTANCE_ARN | jq '.Applications[] | select(.Name | contains("TEAM")) | {Name, ApplicationArn, Status}'
```

Expected: Application named "TEAM" or similar exists

---

## Step 5: Configure parameters.sh

**Do not assume parameters.sh is already configured.** It may have default values. Update it with the correct values.

### Required values

Get these from Terraform outputs or ask the user:

| Parameter | Source | Example |
|-----------|--------|---------|
| `TEAM_ACCOUNT` | AWS Account ID | `123456789012` |
| `REGION` | AWS Region | `eu-west-1` |
| `TEAM_ACCOUNT_PROFILE` | AWS CLI profile | `my-account/AdminRole` |
| `IDC_LOGIN_URL` | IAM Identity Center start URL | `https://d-xxxxxxxxxx.awsapps.com/start` |
| `TEAM_ADMIN_GROUP` | Admin group name in IdC | `team-admin-group` |
| `TEAM_AUDITOR_GROUP` | Auditor group name in IdC | `team-auditor-group` |
| `CLOUDTRAIL_AUDIT_LOGS` | CloudTrail Event Data Store ARN | `arn:aws:cloudtrail:...` |

### Get Account ID from current session

```bash
aws sts get-caller-identity --profile "$AWS_PROFILE" --output json | jq -r '.Account'
```

### Update parameters.sh

Read current values and update if needed:

```bash
cd $TEAM_REPO/deployment
cat parameters.sh | grep -E "^export"
```

Update the file with correct values using Edit tool. Key exports to verify/update:

```bash
export TEAM_ACCOUNT=<account-id>
export REGION=<region>
export TEAM_ACCOUNT_PROFILE=<profile-name>
export IDC_LOGIN_URL=<sso-start-url>
export TEAM_ADMIN_GROUP="<admin-group>"
export TEAM_AUDITOR_GROUP="<auditor-group>"
```

### Branch-specific handling

If deploying to a branch other than `main`, temporarily modify the scripts before running them.

**Hardcoded "main" locations:**

| File | Line | Code |
|------|------|------|
| integration.sh | 35 | `amplifyDomain="main.$amplifyDomain"` |
| integration.sh | 41 | `.branchName=="main"` |
| cognito.sh | 31 | `amplifyDomain="main.$amplifyDomain"` |
| cognito.sh | 37 | `.branchName=="main"` |

**Before running scripts (if BRANCH_NAME != "main"):**

```bash
cd $TEAM_REPO/deployment

# Backup and replace "main" with branch name (both patterns in one command)
sed -i.bak \
  -e "s/\"main\.\$amplifyDomain\"/\"$BRANCH_NAME.\$amplifyDomain\"/g" \
  -e "s/branchName==\"main\"/branchName==\"$BRANCH_NAME\"/g" \
  integration.sh cognito.sh
```

**After running scripts - restore originals:**

```bash
cd $TEAM_REPO/deployment
mv integration.sh.bak integration.sh
mv cognito.sh.bak cognito.sh
```

**Important:** Always restore the scripts after running to avoid committing branch-specific changes.

### Verify details.json

This file contains the SAML metadata URL from IAM Identity Center. Verify it exists and has the correct URL:

```bash
cat $TEAM_REPO/deployment/details.json
```

Expected format:
```json
{
  "MetadataURL": "https://portal.sso.<region>.amazonaws.com/saml/metadata/<id>"
}
```

If incorrect, get the metadata URL from IAM Identity Center console → TEAM application → SAML metadata.

---

## Step 6: Run integration.sh

**If BRANCH_NAME != "main":** Apply branch substitution from Step 5 first.

```bash
cd $TEAM_REPO/deployment
./integration.sh
```

### Expected output

```
applicationStartURL: https://<domain>/?auto_login=true
applicationACSURL: https://<cognito-domain>.auth.<region>.amazoncognito.com/saml2/idpresponse
applicationSAMLAudience: urn:amazon:cognito:sp:<user-pool-id>
```

**Save these values** for IAM Identity Center configuration.

---

## Step 7: Update IAM Identity Center Application

**Note:** SAML configuration for custom apps cannot be verified via CLI. Use the AWS Console.

### Manual steps (GUI)

1. Go to IAM Identity Center console → Applications
2. Find TEAM application
3. Edit configuration:
   - **Application start URL**: `applicationStartURL` from step 6
   - **Application ACS URL**: `applicationACSURL` from step 6  
   - **Application SAML audience**: `applicationSAMLAudience` from step 6
4. Save changes

### Verify Start URL via CLI

Only the Start URL can be verified via CLI:

```bash
APP_ARN=$(aws sso-admin list-applications --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --instance-arn $INSTANCE_ARN | jq -r '.Applications[] | select(.Name | contains("TEAM")) | .ApplicationArn')

aws sso-admin describe-application --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --application-arn $APP_ARN | jq '.PortalOptions.SignInOptions.ApplicationUrl'
```

### Get SAML metadata URL for details.json

From IAM Identity Center application → Download SAML metadata or copy metadata URL.

Update `deployment/details.json`:
```json
{
  "MetadataURL": "https://portal.sso.<region>.amazonaws.com/saml/metadata/<id>"
}
```

---

## Step 8: Run cognito.sh

**If BRANCH_NAME != "main":** Branch substitution should already be applied from Step 6.

```bash
cd $TEAM_REPO/deployment
./cognito.sh
```

**After cognito.sh completes:** Restore original scripts (see Step 5 - "After running scripts").

### What it does

1. Creates IDC identity provider in Cognito (SAML)
2. Configures App Client:
   - Callback URLs: `https://<amplify-domain>/`
   - Logout URLs: `https://<amplify-domain>/`
   - OAuth flows: `code`
   - OAuth scopes: phone, email, openid, profile, aws.cognito.signin.user.admin

### If IDC provider already exists

Delete it first:
```bash
aws cognito-idp delete-identity-provider \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --user-pool-id $POOL_ID \
  --provider-name IDC
```

Then run cognito.sh again.

---

## Step 9: Verify Cognito Configuration

### Check Identity Provider

```bash
aws cognito-idp describe-identity-provider \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --output json \
  --user-pool-id $POOL_ID \
  --provider-name IDC | jq '.IdentityProvider | {ProviderName, ProviderType}'
```

### Check App Client Configuration

```bash
CLIENT_ID=$(aws cognito-idp list-user-pool-clients --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --user-pool-id $POOL_ID | jq -r '.UserPoolClients[] | select(.ClientName | contains("clientWeb")) | .ClientId' | head -1)

aws cognito-idp describe-user-pool-client \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --output json \
  --user-pool-id $POOL_ID \
  --client-id $CLIENT_ID | jq '.UserPoolClient | {CallbackURLs, LogoutURLs, SupportedIdentityProviders}'
```

### Verify callback URLs match Amplify URL

Compare:
- Cognito callback URL from above
- Amplify app URL from Step 2

They must match! If using custom domain, both should use custom domain.

---

## Step 10: Test Login Flow

1. Open Amplify app URL in browser
2. Click "Sign in with AWS" 
3. Should redirect to IAM Identity Center login
4. After login, should redirect back to TEAM app
5. Verify user is authenticated and can see dashboard

---

## Final Summary

After completing all steps, present a summary table:

| Component | Status | Detail |
|-----------|--------|--------|
| Amplify App | ✅/❌ | App ID, domain, deploy status |
| Cognito Pool | ✅/❌ | Pool ID |
| Cognito Domain | ✅/❌ | Full domain URL |
| IAM IdC App | ✅/❌ | ENABLED/DISABLED |
| IDC Provider | ✅/❌ | Created/Missing |
| Callback URLs | ✅/❌ | Correct URL or what was fixed |
| Logout URLs | ✅/❌ | Correct URL or what was fixed |
| Login Test | ✅/❌ | Working/Failed |

If any items were fixed during this check, note what changed.

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| jq parse error: Invalid numeric literal | AWS CLI outputs YAML, not JSON | Add `--output json` to all AWS commands |
| "No user pools found" | Amplify backend not deployed | Trigger Amplify build |
| cognito.sh: "provider already exists" | IDC provider exists | Delete provider, run again |
| Login redirect fails | ACS URL mismatch | Check IAM IdC app config |
| Callback URL error | URL mismatch | Verify Cognito callback = Amplify URL |
| "Invalid SAML response" | Metadata URL wrong | Update details.json |
| App shows blank after login | CORS or JWT issue | Check browser console |

---

## Quick Reference: All Required Commands

```bash
# Variables (set these first)
AWS_PROFILE="<your-aws-profile>"
AWS_REGION="<your-region>"
TEAM_REPO="<path-to-team-repo>"

# Get IDs
APP_ID=$(aws amplify list-apps --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq -r '.apps[] | select(.name=="TEAM-IDC-APP") | .appId')
POOL_ID=$(aws cognito-idp list-user-pools --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json --max-results 10 | jq -r '.UserPools[] | select(.Name | contains("teamAuth")) | .Id' | head -1)
INSTANCE_ARN=$(aws sso-admin list-instances --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq -r '.Instances[0].InstanceArn')

# Amplify URL
echo "https://main.$(aws amplify list-apps --profile "$AWS_PROFILE" --region "$AWS_REGION" --output json | jq -r '.apps[] | select(.name=="TEAM-IDC-APP") | .defaultDomain')"

# Run scripts
cd $TEAM_REPO/deployment
./integration.sh
./cognito.sh
```
