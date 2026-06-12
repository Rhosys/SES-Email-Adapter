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
const AWS_REGION = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'eu-central-1';
const version = `0.0.${process.env['GITHUB_RUN_NUMBER'] ?? process.env['CI_PIPELINE_ID'] ?? '0'}`;

// Bucket convention matches the rhosys deployments pattern; override via DEPLOYMENT_BUCKET if needed
const deploymentBucket = process.env['DEPLOYMENT_BUCKET']
  ?? `rhosys-deployments-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}`;

// Function name matches Tofu: "${app_name}-${env}-main"
const functionName = process.env['LAMBDA_FUNCTION_NAME'];

// Isolated Lambda function names (match Tofu resource names)
const userCodeExecutorFunctionName = process.env['USER_CODE_EXECUTOR_FUNCTION_NAME'];
const contentSanitizerFunctionName = process.env['CONTENT_SANITIZER_FUNCTION_NAME'];

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
      sourcemap: true,
      platform: 'node' as const,
      target: 'node24',
      format: 'esm' as const,
      external: ['@aws-sdk/*', 'pg-native'],
      // CJS deps that call require() or reference __dirname/__filename need shims in ESM context.
      banner: { js: "import { createRequire } from 'module'; import { fileURLToPath as __ef_furl } from 'url'; import { dirname as __ef_dir } from 'path'; const require = createRequire(import.meta.url); const __filename = __ef_furl(import.meta.url); const __dirname = __ef_dir(__filename);" },
    };

    console.log(`Building ${functionName} v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/handler.ts'],
      outfile: 'dist/main/handler.js',
    });

    // Migration runner — same zip, separate entry point for CodeBuild
    console.log(`Building migration runner v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/migrations/migrate-handler.ts'],
      outfile: 'dist/main/migrate.js',
    });

    // Copy migration SQL + meta files into the bundle (esbuild doesn't handle .sql/.json assets)
    const { mkdirSync, copyFileSync, readdirSync } = await import('node:fs');
    const migrationsSrcDir = 'src/migrations';
    const migrationsDestDir = 'dist/main/migrations';
    mkdirSync(migrationsDestDir, { recursive: true });
    const metaDestDir = `${migrationsDestDir}/meta`;
    mkdirSync(metaDestDir, { recursive: true });
    for (const file of readdirSync(migrationsSrcDir).filter(f => f.endsWith('.sql'))) {
      copyFileSync(`${migrationsSrcDir}/${file}`, `${migrationsDestDir}/${file}`);
    }
    const metaSrcDir = `${migrationsSrcDir}/meta`;
    for (const file of readdirSync(metaSrcDir).filter(f => f.endsWith('.json'))) {
      copyFileSync(`${metaSrcDir}/${file}`, `${metaDestDir}/${file}`);
    }

    // Bundle KMS-encrypted secrets alongside the handler
    mkdirSync('dist/main/processor/calendar', { recursive: true });
    copyFileSync('src/processor/calendar/calendar-hmac.kms', 'dist/main/processor/calendar/calendar-hmac.kms');

    console.log(`Building ${userCodeExecutorFunctionName} v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/isolated/user-code-executor.ts'],
      outfile: 'dist/main/user-code-executor.js',
    });

    console.log(`Building ${contentSanitizerFunctionName} v${version}...`);
    await esbuild.build({
      ...esbuildDefaults,
      entryPoints: ['src/isolated/content-sanitizer.ts'],
      outfile: 'dist/main/content-sanitizer.js',
    });

    // -----------------------------------------------------------------------
    // Upload single artifact and deploy all Lambda functions from it
    // -----------------------------------------------------------------------
    const architect = new AwsArchitect(packageMetadata, {
      deploymentBucket,
      sourceDirectory: path.join(process.cwd(), 'dist/main'),
      description: packageMetadata.description,
      regions: [AWS_REGION],
    });

    console.log(`Uploading artifact to s3://${deploymentBucket}...`);
    await architect.publishLambdaArtifactPromise();

    console.log(`Deploying ${functionName} alias 'production'...`);
    const result = await architect.publishAndDeployStagePromise({
      stage: 'production',
      functionName,
      deploymentKeyName: `${packageMetadata.name}/${version}/lambda.zip`,
    });
    console.log(result);

    console.log(`Deploying ${userCodeExecutorFunctionName} alias 'production'...`);
    const userCodeResult = await architect.publishAndDeployStagePromise({
      stage: 'production',
      functionName: userCodeExecutorFunctionName,
      deploymentKeyName: `${packageMetadata.name}/${version}/lambda.zip`,
    });
    console.log(userCodeResult);

    console.log(`Deploying ${contentSanitizerFunctionName} alias 'production'...`);
    const contentSanitizerResult = await architect.publishAndDeployStagePromise({
      stage: 'production',
      functionName: contentSanitizerFunctionName,
      deploymentKeyName: `${packageMetadata.name}/${version}/lambda.zip`,
    });
    console.log(contentSanitizerResult);

    // -----------------------------------------------------------------------
    // Trigger database migrations via CodeBuild (non-blocking)
    // -----------------------------------------------------------------------
    const codebuildProject = process.env['CODEBUILD_MIGRATE_PROJECT'];
    const { CodeBuildClient, StartBuildCommand } = await import('@aws-sdk/client-codebuild');
    const codebuild = new CodeBuildClient({});
    const sourceLocation = `${deploymentBucket}/${packageMetadata.name}/${version}/lambda.zip`;
    console.log(`Triggering migrations via CodeBuild (source: ${sourceLocation})...`);
    const buildResult = await codebuild.send(new StartBuildCommand({
      projectName: codebuildProject,
      sourceLocationOverride: sourceLocation,
      sourceTypeOverride: 'S3',
    }));
    console.log(`CodeBuild migration started: ${buildResult.build?.id}`);
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
