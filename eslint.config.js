import { typescriptConfig } from "@authress/eslint-config/typescript";

export default [
  // Type-aware TypeScript rules (no-floating-promises + must-use-result)
  ...typescriptConfig,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The shared config's args:"after-used" doesn't exempt a leading underscore — but this
      // codebase already uses that convention everywhere for interface-mandated unused params
      // (e.g. ProviderAdapter.deactivate(_emx)). Recognize it instead of fighting it file by file.
      "@typescript-eslint/no-unused-vars": ["error", { vars: "all", args: "after-used", argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },

  // Project-specific: restricted imports for processor isolation (ADR 011)
  {
    files: ["src/processor/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "jsqr", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
          { name: "pngjs", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
          { name: "jpeg-js", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
          { name: "jszip", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
          { name: "mailparser", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
          { name: "dompurify", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
          { name: "happy-dom", message: "Content parsing must happen in src/isolated/ (ADR 011)." },
        ],
      }],
    },
  },
];
