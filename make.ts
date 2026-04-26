import AwsArchitect from 'aws-architect';
import * as esbuild from 'esbuild';
import path from 'path';
import { Command } from 'commander';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const packageMetadata = require('./package.json') as { name: string; version: string; description: string };

// ---------------------------------------------------------------------------
// Environment — all values injected; nothing hardcoded
// ---------------------------------------------------------------------------

const AWS_ACCOUNT_ID = process.env['AWS_ACCOUNT_ID'];
if (!AWS_ACCOUNT_ID) throw new Error('AWS_ACCOUNT_ID is required');

const AWS_REGION   = process.env['AWS_REGION'] ?? 'us-east-1';
const ENV          = process.env['ENV'] ?? 'prod';
const version      = `0.0.${process.env['CI_PIPELINE_ID'] ?? '0'}`;

// Bucket convention matches the rhosys deployments pattern; override via DEPLOYMENT_BUCKET if needed
const deploymentBucket = process.env['DEPLOYMENT_BUCKET']
  ?? `rhosys-deployments-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}`;

// Function name matches Tofu: "${app_name}-${env}-main"
const functionName = process.env['LAMBDA_FUNCTION_NAME']
  ?? `${packageMetadata.name}-${ENV}-main`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();
program.version(version);

program
  .command('start')
  .description('Run Lambda handler locally via aws-architect HTTP server.')
  .action(async () => {
    packageMetadata.version = version;

    const awsArchitect = new AwsArchitect(packageMetadata, {
      deploymentBucket,
      sourceDirectory: path.join(process.cwd(), 'src'),
      description: packageMetadata.description,
      regions: [AWS_REGION],
    });

    process.env['AWS_XRAY_CONTEXT_MISSING'] = 'LOG_ERROR';
    process.env['AWS_REGION'] = AWS_REGION;

    const result = await awsArchitect.run(8080, () => { /* suppress server output */ });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('deploy')
  .description('Build and deploy to AWS (CI only).')
  .action(async () => {
    if (!process.env['CI_COMMIT_REF_SLUG']) {
      console.log('Deployment should only run in CI. Set CI_COMMIT_REF_SLUG to proceed.');
      return;
    }

    packageMetadata.version = version;

    console.log(`Building ${functionName} v${version}...`);
    await esbuild.build({
      entryPoints: ['src/handler.ts'],
      bundle: true,
      minify: true,
      platform: 'node',
      target: 'node22',
      // @aws-sdk/* is provided by the Lambda runtime; pg-native is optional and not used
      external: ['@aws-sdk/*', 'pg-native'],
      outfile: 'dist/handler.js',
    });

    const awsArchitect = new AwsArchitect(packageMetadata, {
      deploymentBucket,
      sourceDirectory: path.join(process.cwd(), 'dist'),
      description: packageMetadata.description,
      regions: [AWS_REGION],
    });

    console.log(`Uploading artifact to s3://${deploymentBucket}...`);
    await awsArchitect.publishLambdaArtifactPromise();

    console.log(`Deploying ${functionName} alias 'production'...`);
    const result = await awsArchitect.publishAndDeployStagePromise({
      stage: 'production',
      functionName,
      deploymentKeyName: `${functionName}/${version}/lambda.zip`,
    });

    console.log(result);
  });

program.on('*', () => {
  console.log(`Unknown Command: ${program.args.join(' ')}`);
  program.help();
  process.exit(0);
});

program
  .parseAsync(process.argv.length > 2 ? process.argv : process.argv.concat(['start']))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
