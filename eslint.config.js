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
