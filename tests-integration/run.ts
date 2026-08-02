import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

const { getCredentials } = await import(join(homedir(), ".kiro/skills/lib/aws-sso-auth.js"));

const { stdout: gitOrigin } = await execFileAsync("git", ["remote", "get-url", "origin"]);
const creds = await getCredentials(undefined, gitOrigin.trim());

const result = await execFileAsync("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"], {
  env: {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_REGION: "eu-central-1",
  },
  maxBuffer: 10 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
