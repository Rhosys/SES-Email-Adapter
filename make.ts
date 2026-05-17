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

const AWS_REGION = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-central-1';
const ENV     = process.env['ENV'] ?? 'prod';
const version = `0.0.${process.env['GITHUB_RUN_NUMBER'] ?? process.env['CI_PIPELINE_ID'] ?? '0'}`;

// Bucket convention matches the rhosys deployments pattern; override via DEPLOYMENT_BUCKET if needed
const deploymentBucket = process.env['DEPLOYMENT_BUCKET']
  ?? `rhosys-deployments-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}`;

// Function name matches Tofu: "${app_name}-${env}-main"
const functionName = process.env['LAMBDA_FUNCTION_NAME']
  ?? `${packageMetadata.name}-${ENV}-main`;

// Isolated Lambda function names (match Tofu resource names)
const userCodeExecutorFunctionName = process.env['USER_CODE_EXECUTOR_FUNCTION_NAME']
  ?? `${packageMetadata.name}-user-code`;
const contentSanitizerFunctionName = process.env['CONTENT_SANITIZER_FUNCTION_NAME']
  ?? `${packageMetadata.name}-content-sanitizer`;

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
    if (!process.env['GITHUB_ACTIONS'] && !process.env['CI_COMMIT_REF_SLUG']) {
      console.log('Deployment should only run in CI. Set GITHUB_ACTIONS=true or CI_COMMIT_REF_SLUG to proceed.');
      return;
    }

    packageMetadata.version = version;

    // -----------------------------------------------------------------------
    // Build all Lambda bundles
    // -----------------------------------------------------------------------
    const esbuildDefaults = {
      bundle: true,
      minify: true,
      platform: 'node' as const,
      target: 'node24',
      format: 'esm' as const,
      external: ['@aws-sdk/*', 'pg-native'],
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    };

    console.log(`Building ${functionName} v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/handler.ts'],
      outfile: 'dist/main/handler.js',
    });

    console.log(`Building ${userCodeExecutorFunctionName} v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/isolated/user-code-executor.ts'],
      outfile: 'dist/user-code-executor/user-code-executor.js',
    });

    console.log(`Building ${contentSanitizerFunctionName} v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/isolated/content-sanitizer.ts'],
      outfile: 'dist/content-sanitizer/content-sanitizer.js',
    });

    // -----------------------------------------------------------------------
    // Upload and deploy — Main Lambda
    // -----------------------------------------------------------------------
    const mainArchitect = new AwsArchitect(packageMetadata, {
      deploymentBucket,
      sourceDirectory: path.join(process.cwd(), 'dist/main'),
      description: packageMetadata.description,
      regions: [AWS_REGION],
    });

    console.log(`Uploading main artifact to s3://${deploymentBucket}...`);
    await mainArchitect.publishLambdaArtifactPromise();

    console.log(`Deploying ${functionName} alias 'production'...`);
    const result = await mainArchitect.publishAndDeployStagePromise({
      stage: 'production',
      functionName,
      deploymentKeyName: `${packageMetadata.name}/${version}/lambda.zip`,
    });
    console.log(result);

    // -----------------------------------------------------------------------
    // Upload and deploy — User Code Executor
    // -----------------------------------------------------------------------
    const userCodeArchitect = new AwsArchitect(packageMetadata, {
      deploymentBucket,
      sourceDirectory: path.join(process.cwd(), 'dist/user-code-executor'),
      description: 'User Code Executor — sandboxed JS execution',
      regions: [AWS_REGION],
    });

    console.log(`Uploading user-code-executor artifact to s3://${deploymentBucket}...`);
    await userCodeArchitect.publishLambdaArtifactPromise({ zipFileName: 'user-code-executor.zip' });

    console.log(`Deploying ${userCodeExecutorFunctionName} alias 'production'...`);
    const userCodeResult = await userCodeArchitect.publishAndDeployStagePromise({
      stage: 'production',
      functionName: userCodeExecutorFunctionName,
      deploymentKeyName: `${packageMetadata.name}/${version}/user-code-executor.zip`,
    });
    console.log(userCodeResult);

    // -----------------------------------------------------------------------
    // Upload and deploy — Content Sanitizer
    // -----------------------------------------------------------------------
    const contentSanitizerArchitect = new AwsArchitect(packageMetadata, {
      deploymentBucket,
      sourceDirectory: path.join(process.cwd(), 'dist/content-sanitizer'),
      description: 'Content Sanitizer — MIME parsing and HTML sanitization',
      regions: [AWS_REGION],
    });

    console.log(`Uploading content-sanitizer artifact to s3://${deploymentBucket}...`);
    await contentSanitizerArchitect.publishLambdaArtifactPromise({ zipFileName: 'content-sanitizer.zip' });

    console.log(`Deploying ${contentSanitizerFunctionName} alias 'production'...`);
    const contentSanitizerResult = await contentSanitizerArchitect.publishAndDeployStagePromise({
      stage: 'production',
      functionName: contentSanitizerFunctionName,
      deploymentKeyName: `${packageMetadata.name}/${version}/content-sanitizer.zip`,
    });
    console.log(contentSanitizerResult);
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
