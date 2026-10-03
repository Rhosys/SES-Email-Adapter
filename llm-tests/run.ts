import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

// CI (build.yml) already injects ambient AWS credentials via its OIDC setup action,
// so interactive device-code SSO must be skipped there — it would hang the runner.
async function resolveEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.env.CI) {
    return { ...process.env, AWS_REGION: "eu-central-1" };
  }

  const { getCredentials } = await import(join(homedir(), ".kiro/skills/lib/aws-sso-auth.js"));
  const { stdout: gitOrigin } = await execFileAsync("git", ["remote", "get-url", "origin"]);
  const creds = await getCredentials(undefined, gitOrigin.trim());
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_REGION: "eu-central-1",
  };
}

const result = await execFileAsync("npx", ["vitest", "run", "--config", "llm-tests/vitest.config.ts"], {
  env: await resolveEnv(),
  maxBuffer: 10 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
