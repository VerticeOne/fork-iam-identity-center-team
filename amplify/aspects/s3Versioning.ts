import { IAspect } from 'aws-cdk-lib';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { IConstruct } from 'constructs';

/**
 * CDK Aspect that enables versioning on all S3 buckets in the construct tree.
 * This ensures Amplify-managed buckets (codegen assets, model introspection schema)
 * have versioning enabled for compliance and data protection.
 */
export class S3BucketVersioning implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnBucket) {
      if (!node.versioningConfiguration) {
        node.versioningConfiguration = {
          status: 'Enabled',
        };
      }
    }
  }
}
