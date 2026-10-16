import { BundlingOutput, DockerImage, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { appIdLower } from '../../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SlackPythonLayerProps {
  stack: Stack;
  env: string;
}

export function createSlackPythonLayer(props: SlackPythonLayerProps): lambda.LayerVersion {
  const { stack, env } = props;

  const layer = new lambda.LayerVersion(stack, 'SlackPythonLayer', {
    layerVersionName: `slackPythonLayer-${appIdLower}-${env}`,
    description: 'Slack integration layer (slack_sdk and shared Slack helpers)',
    compatibleRuntimes: [
      lambda.Runtime.PYTHON_3_14,
    ],
    compatibleArchitectures: [lambda.Architecture.ARM_64],
    code: lambda.Code.fromAsset(path.join(__dirname, 'lib/python'), {
      bundling: {
        image: DockerImage.fromRegistry('public.ecr.aws/sam/build-python3.14:latest-arm64'),
        command: [
          'bash', '-c',
          'pip install -r requirements.txt -t /asset-output/python && cp *.py /asset-output/python/ 2>/dev/null || true',
        ],
        outputType: BundlingOutput.AUTO_DISCOVER,
        local: {
          tryBundle(outputDir: string) {
            try {
              execSync('pip --version');
            } catch {
              return false;
            }
            const pythonDir = path.join(outputDir, 'python');
            const sourceDir = path.join(__dirname, 'lib/python');
            fs.mkdirSync(pythonDir, { recursive: true });
            execSync(`pip install -r "${path.join(sourceDir, 'requirements.txt')}" --target "${pythonDir}"`);
            // Copy custom Python modules to layer
            const pyFiles = fs.readdirSync(sourceDir).filter(f => f.endsWith('.py'));
            for (const pyFile of pyFiles) {
              fs.copyFileSync(path.join(sourceDir, pyFile), path.join(pythonDir, pyFile));
            }
            return true;
          },
        },
      },
    }),
  });

  return layer;
}
