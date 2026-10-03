#!/usr/bin/env tsx
/**
 * Integration TF transformer.
 *
 * Reads the real production `deploy/*.tf`, parses each to a structured tree
 * (hcl2json), applies the few transforms MiniStack still needs, and emits
 * `.tf.json` into a work dir. Terraform reads `.tf.json` natively, so the
 * integration apply runs the real config — no text munging, brace/comment proof,
 * and new provider aliases flow through automatically.
 *
 * Usage: tsx transform-tf.ts <deployDir> <workDir> [endpoint]
 *
 * The prod providers.tf is NOT copied. Instead we discover its aws provider
 * aliases and regenerate each as a MiniStack-pointing provider (same alias,
 * test creds, local endpoints). The prod `terraform {}` backend block is dropped
 * — integration uses local state. The `tls`, `random`, and `archive` providers
 * run locally unchanged, so they are re-declared verbatim in required_providers.
 *
 * MiniStack-gap philosophy: as of MiniStack 1.5.21 (API Gateway v2 domain names +
 * mappings) and 1.5.20 (DynamoDB streams + global-table replicas), the attributes
 * the old CI stripped with `sed` (replica, point_in_time_recovery,
 * deletion_protection_enabled, stream_enabled/stream_view_type) all run natively.
 * Nothing is stripped here: we assume MiniStack serves everything and build strip
 * rules back only for concrete failures (each becomes a tracked ticket).
 *
 * Authress: unlike gitzi, email-catcher has no Authress TF provider — its Authress
 * signing key is a real `aws_kms_key` (Ed25519 SIGN_VERIFY) that MiniStack serves
 * directly. There is nothing to swap.
 */
import { parse } from "@cdktf/hcl2json";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

// Resources MiniStack 1.5.21 does not serve — stripped from the apply. Each is a
// tracked MiniStack gap, not a permanent exclusion: when MiniStack implements the
// listed AWS action, delete the entry and the real resource flows through again.
// The integration suite stubs the email service and creates its own S3/SQS, so it
// exercises none of these — stripping them loses no test coverage.
//
// Two MiniStack tickets cover the gap, by the AWS actions each resource needs:
//
// TICKET 1 — Amazon SES (v1 receipt rules + v2 sending):
//   aws_ses_receipt_rule_set                  → [CreateReceiptRuleSet](https://docs.aws.amazon.com/ses/latest/APIReference/API_CreateReceiptRuleSet.html)
//   aws_ses_active_receipt_rule_set           → [SetActiveReceiptRuleSet](https://docs.aws.amazon.com/ses/latest/APIReference/API_SetActiveReceiptRuleSet.html)
//   aws_ses_receipt_rule                      → [CreateReceiptRule](https://docs.aws.amazon.com/ses/latest/APIReference/API_CreateReceiptRule.html)
//   aws_sesv2_configuration_set               → [CreateConfigurationSet](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_CreateConfigurationSet.html) + [ListTagsForResource](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_ListTagsForResource.html)
//   aws_sesv2_configuration_set_event_destination → [CreateConfigurationSetEventDestination](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_CreateConfigurationSetEventDestination.html)
//   aws_sesv2_email_identity                  → [CreateEmailIdentity](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_CreateEmailIdentity.html)
//   aws_sesv2_email_identity_mail_from_attributes → [PutEmailIdentityMailFromAttributes](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_PutEmailIdentityMailFromAttributes.html)
//   aws_sesv2_dedicated_ip_pool               → [CreateDedicatedIpPool](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_CreateDedicatedIpPool.html)
//   aws_sesv2_tenant                          → [CreateTenant](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_CreateTenant.html)
//   aws_sesv2_tenant_resource_association     → [CreateTenantResourceAssociation](https://docs.aws.amazon.com/sesv2/latest/APIReference/API_CreateTenantResourceAssociation.html)
//
// TICKET 2 — Amazon Bedrock foundation-model Marketplace agreements:
//   terraform_data.bedrock_model_subscription (local-exec) →
//     [ListFoundationModelAgreementOffers](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModelAgreementOffers.html) +
//     [CreateFoundationModelAgreement](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_CreateFoundationModelAgreement.html)
//
// "*" removes all named instances of the type.
const REMOVE_RESOURCES: Record<string, "*" | string[]> = {
  // TICKET 1 — SES
  aws_ses_receipt_rule_set: "*",
  aws_ses_active_receipt_rule_set: "*",
  aws_ses_receipt_rule: "*",
  aws_sesv2_configuration_set: "*",
  aws_sesv2_configuration_set_event_destination: "*",
  aws_sesv2_email_identity: "*",
  aws_sesv2_email_identity_mail_from_attributes: "*",
  aws_sesv2_dedicated_ip_pool: "*",
  aws_sesv2_tenant: "*",
  aws_sesv2_tenant_resource_association: "*",
  // TICKET 2 — Bedrock Marketplace agreement
  terraform_data: ["bedrock_model_subscription"],
};

/** Remove named (or all) instances of a resource type from a parsed file. */
function removeResources(resourceContainer: Record<string, unknown> | undefined): void {
  if (!resourceContainer) return;
  for (const [type, names] of Object.entries(REMOVE_RESOURCES)) {
    const byName = resourceContainer[type] as Record<string, unknown> | undefined;
    if (!byName) continue;
    if (names === "*") {
      delete resourceContainer[type];
      continue;
    }
    for (const name of names) delete byName[name];
    if (Object.keys(byName).length === 0) delete resourceContainer[type];
  }
}

// Attributes referencing a removed resource that must be scrubbed to avoid a
// dangling reference:
//   - sending_pool_name → stripped dedicated IP pool (config set still delivers)
//   - SES_CONFIGURATION_SET_ARN → stripped config set; a lambda env var the
//     integration harness never reads (it stubs the email service).
const SCRUB_ATTRIBUTES = new Set(["sending_pool_name", "SES_CONFIGURATION_SET_ARN"]);

// Outputs that reference a removed resource — dropped wholesale, since an output
// pointing at a stripped resource fails at apply.
const REMOVE_OUTPUTS = new Set(["ses_rule_set_name"]);

/** Delete outputs that reference removed resources. */
function removeOutputs(tree: TfTree): void {
  const output = tree["output"] as Record<string, unknown> | undefined;
  if (!output) return;
  for (const name of REMOVE_OUTPUTS) delete output[name];
  if (Object.keys(output).length === 0) delete tree["output"];
}

/** Recursively delete any key in SCRUB_ATTRIBUTES — removes attributes that
 *  referenced a resource removeResources() stripped. */
function scrubDanglingAttributes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) scrubDanglingAttributes(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SCRUB_ATTRIBUTES.has(key)) {
      delete obj[key];
      continue;
    }
    scrubDanglingAttributes(obj[key]);
  }
}

// The AWS services MiniStack serves — used to build each provider's endpoints.
const MINISTACK_SERVICES = [
  "acm", "apigateway", "apigatewayv2", "bedrock", "cloudfront", "cloudwatch",
  "dynamodb", "events", "iam", "kms", "lambda", "logs", "rdsdata", "route53",
  "s3", "scheduler", "secretsmanager", "ses", "sesv2", "sns", "sqs", "sfn", "sts",
];

type TfTree = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Transforms — these unwrap hcl2json's `${...}` wrapping in positions .tf.json
// rejects. They are syntax fixes, not MiniStack gaps.
// ---------------------------------------------------------------------------

/** hcl2json renders `variable` type keywords as interpolations (`type = string`
 *  becomes `"${string}"`), which `.tf.json` rejects. Unwrap `${...}` back to the
 *  bare expression so the type constructor is valid again. */
function unwrapVariableTypes(variableBlock: unknown): void {
  if (!variableBlock || typeof variableBlock !== "object") return;
  for (const instances of Object.values(variableBlock as Record<string, unknown>)) {
    const list = Array.isArray(instances) ? instances : [instances];
    for (const v of list) {
      if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        const t = obj["type"];
        if (typeof t === "string") {
          const m = /^\$\{(.+)\}$/.exec(t);
          if (m) obj["type"] = m[1];
        }
      }
    }
  }
}

/** The resource/data `provider` meta-argument (`provider = aws.us_east_1`) is
 *  rendered by hcl2json as `"${aws.us_east_1}"`. In .tf.json it must be the bare
 *  reference string `"aws.us_east_1"`. Unwrap it wherever it appears. */
function unwrapProviderMetaArg(container: unknown): void {
  if (!container || typeof container !== "object") return;
  for (const byName of Object.values(container as Record<string, unknown>)) {
    if (!byName || typeof byName !== "object") continue;
    for (const instances of Object.values(byName as Record<string, unknown>)) {
      const list = Array.isArray(instances) ? instances : [instances];
      for (const inst of list) {
        if (inst && typeof inst === "object") {
          const obj = inst as Record<string, unknown>;
          const p = obj["provider"];
          if (typeof p === "string") {
            const m = /^\$\{(.+)\}$/.exec(p);
            if (m) obj["provider"] = m[1];
          }
        }
      }
    }
  }
}

/** Meta-argument positions that require bare static references, where hcl2json's
 *  `${...}` wrapping is rejected by .tf.json: lifecycle.ignore_changes and
 *  depends_on (both arrays of references). Unwrap each entry. */
function unwrapStructuralRefs(container: unknown): void {
  if (!container || typeof container !== "object") return;
  const unwrap = (s: unknown): unknown =>
    typeof s === "string" ? s.replace(/^\$\{(.+)\}$/, "$1") : s;

  for (const byName of Object.values(container as Record<string, unknown>)) {
    if (!byName || typeof byName !== "object") continue;
    for (const instances of Object.values(byName as Record<string, unknown>)) {
      const list = Array.isArray(instances) ? instances : [instances];
      for (const inst of list) {
        if (!inst || typeof inst !== "object") continue;
        const obj = inst as Record<string, unknown>;
        if (Array.isArray(obj["depends_on"])) obj["depends_on"] = obj["depends_on"].map(unwrap);
        const lifecycles = obj["lifecycle"];
        if (lifecycles) {
          for (const lc of Array.isArray(lifecycles) ? lifecycles : [lifecycles]) {
            if (lc && typeof lc === "object" && Array.isArray((lc as Record<string, unknown>)["ignore_changes"])) {
              const rec = lc as Record<string, unknown>;
              rec["ignore_changes"] = (rec["ignore_changes"] as unknown[]).map(unwrap);
            }
          }
        }
      }
    }
  }
}

/** Production reads the DKIM private key via `data.aws_kms_secrets.dkim`, a KMS
 *  Decrypt of a committed ciphertext file. A Decrypt can't be seeded against
 *  MiniStack, so the block is dropped and every reference to its decrypted
 *  plaintext is rewritten to a locally-generated key (see DKIM_BRIDGE). The
 *  production value is the base64 DER body (PEM headers stripped); the bridge
 *  local reproduces that exact shape from a generated tls_private_key. */
const DKIM_SECRET_REF = /data\.aws_kms_secrets\.dkim\.plaintext\["private_key"\]/g;
const DKIM_BRIDGE_LOCAL = "local.dkim_integration_der_body";

/** The generated bridge: a tls_private_key plus a local that strips the PEM
 *  wrapper to the base64 DER body production's data source would have yielded. */
const DKIM_BRIDGE = {
  resource: [{
    tls_private_key: [{
      dkim_integration: [{ algorithm: "RSA", rsa_bits: 2048 }],
    }],
  }],
  locals: [{
    // private_key_pem_pkcs8 emits a "BEGIN PRIVATE KEY" (PKCS#8) body, matching
    // the PEM wrapper production's tls_public_key.dkim rebuilds around the value.
    dkim_integration_der_body:
      "${replace(replace(replace(tls_private_key.dkim_integration.private_key_pem_pkcs8, \"/-----[A-Z ]+-----/\", \"\"), \"\\n\", \"\"), \"\\r\", \"\")}",
  }],
};

/** Drop the dkim aws_kms_secrets data block and rewrite every reference to its
 *  plaintext to the generated bridge local. Recurses the whole tree because the
 *  references live in string interpolations scattered across resources/outputs. */
function replaceDkimSecret(tree: TfTree): void {
  const data = tree["data"] as Record<string, unknown> | undefined;
  const kmsSecrets = data?.["aws_kms_secrets"] as Record<string, unknown> | undefined;
  if (kmsSecrets && "dkim" in kmsSecrets) {
    delete kmsSecrets["dkim"];
    if (Object.keys(kmsSecrets).length === 0) delete data!["aws_kms_secrets"];
  }
  rewriteDkimRefs(tree);
}

function rewriteDkimRefs(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteDkimRefs(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string" && val.includes('data.aws_kms_secrets.dkim.plaintext["private_key"]')) {
      obj[key] = val.replace(DKIM_SECRET_REF, DKIM_BRIDGE_LOCAL);
    } else {
      rewriteDkimRefs(val);
    }
  }
}

/** hcl2json emits `aws_security_group` egress/ingress blocks with only the
 *  attributes written in HCL. In HCL, TF fills the rest with defaults, but
 *  `.tf.json` validates the rule as a fully-specified object and rejects it
 *  unless every attribute is present. Fill the required-but-absent attributes
 *  with their empty defaults so the object validates. */
function normalizeSecurityGroupRules(resourceContainer: unknown): void {
  if (!resourceContainer || typeof resourceContainer !== "object") return;
  const sgs = (resourceContainer as Record<string, unknown>)["aws_security_group"];
  if (!sgs || typeof sgs !== "object") return;

  const ruleDefaults = {
    description: "",
    ipv6_cidr_blocks: [],
    prefix_list_ids: [],
    security_groups: [],
    self: false,
    cidr_blocks: [],
  };

  for (const instances of Object.values(sgs as Record<string, unknown>)) {
    const list = Array.isArray(instances) ? instances : [instances];
    for (const inst of list) {
      if (!inst || typeof inst !== "object") continue;
      for (const direction of ["egress", "ingress"]) {
        const rules = (inst as Record<string, unknown>)[direction];
        if (!rules) continue;
        for (const rule of Array.isArray(rules) ? rules : [rules]) {
          if (rule && typeof rule === "object") {
            Object.assign(rule, { ...ruleDefaults, ...(rule as Record<string, unknown>) });
          }
        }
      }
    }
  }
}

/** Build a MiniStack aws provider block for one alias. */
function ministackProvider(alias: string | undefined, region: string, endpoint: string): Record<string, unknown> {
  const block: Record<string, unknown> = {
    region,
    access_key: "ministack-test",
    secret_key: "ministack-test",
    s3_use_path_style: true,
    skip_credentials_validation: true,
    skip_requesting_account_id: true,
    skip_metadata_api_check: true,
    endpoints: [Object.fromEntries(MINISTACK_SERVICES.map((s) => [s, endpoint]))],
  };
  if (alias) block.alias = alias;
  return block;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [deployDir, workDir, endpointArg] = process.argv.slice(2);
  if (!deployDir || !workDir) {
    process.stderr.write("usage: transform-tf.ts <deployDir> <workDir> [endpoint]\n");
    process.exit(1);
  }
  const endpoint = endpointArg ?? "http://localhost:4566";

  const files = (await readdir(deployDir)).filter((f) => f.endsWith(".tf"));

  // Discover aws provider aliases from the real providers.tf so every alias
  // (default, us_east_1, and any future one) flows through.
  const providerAliases: { alias: string | undefined; region: string }[] = [];

  for (const file of files) {
    const text = await readFile(path.join(deployDir, file), "utf8");
    const tree = (await parse(file, text)) as TfTree;

    // Drop the terraform{} block (backend + required_providers): integration
    // uses local state, and we emit our own required_providers once below.
    delete tree["terraform"];

    // Capture + strip aws provider blocks (regenerated centrally below). The
    // prod default/us_east_1 blocks carry allowed_account_ids + default_tags
    // that MiniStack rejects; the regenerated blocks drop them.
    const providerBlock = tree["provider"] as Record<string, unknown> | undefined;
    if (providerBlock) {
      const aws = providerBlock["aws"];
      if (aws) {
        const list = Array.isArray(aws) ? aws : [aws];
        for (const p of list as Record<string, unknown>[]) {
          providerAliases.push({ alias: p["alias"] as string | undefined, region: (p["region"] as string) ?? "eu-central-1" });
        }
        delete providerBlock["aws"];
      }
      if (Object.keys(providerBlock).length === 0) delete tree["provider"];
    }

    // Apply structural transforms (hcl2json `${...}` unwrapping).
    unwrapVariableTypes(tree["variable"]);
    unwrapProviderMetaArg(tree["resource"]);
    unwrapProviderMetaArg(tree["data"]);
    unwrapStructuralRefs(tree["resource"]);
    unwrapStructuralRefs(tree["data"]);
    normalizeSecurityGroupRules(tree["resource"]);
    removeResources(tree["resource"] as Record<string, unknown> | undefined);
    removeOutputs(tree);
    scrubDanglingAttributes(tree["resource"]);
    replaceDkimSecret(tree);

    // Drop now-empty top-level containers — an empty {"data":{}} / {"resource":{}}
    // is invalid .tf.json (a block needs at least one label).
    for (const container of ["resource", "data", "provider", "module", "output", "variable", "locals"]) {
      const v = tree[container];
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) delete tree[container];
    }

    // Emit .tf.json only if the file still has content.
    if (Object.keys(tree).length > 0) {
      await writeFile(path.join(workDir, `${file}.json`), JSON.stringify(tree, null, 2));
    }
  }

  // Emit a single _providers.tf.json: required_providers + regenerated aws
  // providers (one per discovered alias) pointing at MiniStack. tls/random/archive
  // run locally unchanged, so they are re-declared as-is.
  const providersDoc = {
    terraform: [{
      required_providers: [{
        aws: { source: "hashicorp/aws", version: "~> 6.0" },
        tls: { source: "hashicorp/tls", version: "~> 4.0" },
        random: { source: "hashicorp/random", version: "~> 3.0" },
        archive: { source: "hashicorp/archive", version: "~> 2.0" },
      }],
    }],
    provider: {
      aws: providerAliases.map((p) => ministackProvider(p.alias, p.region, endpoint)),
    },
  };
  await writeFile(path.join(workDir, "_providers.tf.json"), JSON.stringify(providersDoc, null, 2));

  // Emit the DKIM bridge: a generated tls_private_key + the local that reshapes
  // it into the base64 DER body the dropped aws_kms_secrets.dkim block supplied.
  await writeFile(
    path.join(workDir, "integration_test_infrastructure_bridge.tf.json"),
    JSON.stringify(DKIM_BRIDGE, null, 2),
  );

  const aliasList = providerAliases.map((p) => p.alias ?? "(default)").join(", ");
  process.stdout.write(`Transformed ${files.length} .tf files → ${workDir}. Provider aliases: ${aliasList}\n`);
}

await main();
