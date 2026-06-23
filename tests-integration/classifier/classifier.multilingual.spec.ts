/**
 * Classifier multilingual integration tests.
 *
 * These tests invoke the REAL Bedrock model (qwen3-32b) and assert correct
 * workflow/workflowData extraction across multiple languages.
 *
 * Run: npm run test:integration
 *
 * Requires: AWS credentials with Bedrock InvokeModel permission in eu-central-1.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { SignalClassifier } from "../../src/classifier/classifier.js";
import type { ClassificationInput } from "../../src/classifier/classifier.js";
import { createConsoleLogger } from "../helpers/logger.js";

function makeInput(overrides: Partial<ClassificationInput>): ClassificationInput {
  return {
    from: "noreply@example.com",
    to: ["user@test.com"],
    subject: "",
    body: "",
    receivedAt: "2025-01-15T10:00:00Z",
    headers: {},
    allowedLabels: [],
    signalId: "sgn-integration-test",
    accountId: "acc-integration-test",
    ...overrides,
  };
}

describe("Classifier multilingual integration", () => {
  let classifier: SignalClassifier;

  beforeAll(() => {
    const client = new BedrockRuntimeClient({ region: "eu-central-1" });
    classifier = new SignalClassifier(client, createConsoleLogger());
  });

  it("German OTP email → workflow:auth, authType:otp", async () => {
    const result = await classifier.classify(makeInput({
      from: "noreply@postbank.de",
      subject: "Ihr Bestätigungscode",
      body: "Ihr Einmalpasswort lautet: 847291. Dieser Code ist 10 Minuten gültig. Falls Sie diese Anfrage nicht gestellt haben, ignorieren Sie diese E-Mail.",
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("auth");
    expect(output.workflowData).toMatchObject({ workflow: "auth", authType: "otp", code: "847291" });
  }, 30_000);

  it("Japanese shipping notification → workflow:package, packageType:shipping", async () => {
    const result = await classifier.classify(makeInput({
      from: "shipping@amazon.co.jp",
      subject: "ご注文の発送のお知らせ",
      body: "ご注文番号 503-1234567-8901234 の商品が発送されました。お届け予定日: 2025年1月18日。配送状況はこちらでご確認ください: https://track.amazon.co.jp/tracking/503-1234567-8901234",
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("package");
    expect(output.workflowData).toMatchObject({ workflow: "package", packageType: "shipping" });
  }, 30_000);

  it("French onboarding welcome email → workflow:onboarding, onboardingType:welcome", async () => {
    const result = await classifier.classify(makeInput({
      from: "bienvenue@notion.so",
      subject: "Bienvenue sur Notion !",
      body: "Bonjour, votre compte Notion est prêt. Cliquez ici pour commencer: https://notion.so/getting-started. Découvrez comment organiser votre travail et collaborer avec votre équipe.",
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("onboarding");
    expect(output.workflowData).toMatchObject({ workflow: "onboarding", onboardingType: "welcome", service: "Notion" });
  }, 30_000);

  it("Spanish payment receipt → workflow:payments, paymentType:receipt", async () => {
    const result = await classifier.classify(makeInput({
      from: "pagos@mercadolibre.com",
      subject: "Recibo de pago - Pedido #ML-9876543",
      body: "Hola, tu pago de $45.990 CLP por el pedido #ML-9876543 ha sido confirmado. Puedes descargar tu recibo aquí: https://mercadolibre.cl/recibos/ML-9876543",
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("payments");
    expect(output.workflowData).toMatchObject({ workflow: "payments", paymentType: "receipt" });
  }, 30_000);

  it("Korean security alert → workflow:alert, alertType:suspicious_login", async () => {
    const result = await classifier.classify(makeInput({
      from: "security@naver.com",
      subject: "비정상적인 로그인 시도가 감지되었습니다",
      body: "귀하의 계정에서 의심스러운 로그인 시도가 감지되었습니다. IP: 203.0.113.42, 위치: 부산. 본인이 아닌 경우 즉시 비밀번호를 변경하세요: https://naver.com/security/password-reset",
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("alert");
    expect((output.workflowData as unknown as Record<string, unknown>).alertType).toBe("suspicious_login");
  }, 30_000);

  it("German onboarding verification with actionUrl extracts the URL not text", async () => {
    const result = await classifier.classify(makeInput({
      from: "noreply@github.com",
      subject: "Bitte bestätigen Sie Ihre E-Mail-Adresse",
      body: "Willkommen bei GitHub! Bitte klicken Sie auf den folgenden Link, um Ihre E-Mail-Adresse zu bestätigen:\n\nhttps://github.com/users/confirm?token=abc123def456\n\nDieser Link ist 24 Stunden gültig.",
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.workflow).toBe("onboarding");
    const wd = output.workflowData as unknown as Record<string, unknown>;
    expect(wd.onboardingType).toBe("verification");
    if (wd.actionUrl) {
      expect(wd.actionUrl).toMatch(/^https?:\/\//);
    }
  }, 30_000);

  it("user-defined labels in non-English are matched correctly", async () => {
    const result = await classifier.classify(makeInput({
      from: "newsletter@techcrunch.com",
      subject: "TechCrunch Daily Newsletter",
      body: "Top stories: OpenAI launches new model, Stripe raises Series D, and more startup news.",
      allowedLabels: ["テクノロジー", "ニュース", "仕事"],
    }));
    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    for (const label of output.labels) {
      expect(["テクノロジー", "ニュース", "仕事"]).toContain(label);
    }
  }, 30_000);
});
