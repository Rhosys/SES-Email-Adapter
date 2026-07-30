import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/processor/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
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
