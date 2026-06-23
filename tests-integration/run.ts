import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const { getCredentials } = await import(join(homedir(), ".kiro/skills/lib/aws-sso-auth.js"));

const gitOrigin = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
const creds = await getCredentials(undefined, gitOrigin);

execFileSync("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    AWS_REGION: "eu-central-1",
  },
});
