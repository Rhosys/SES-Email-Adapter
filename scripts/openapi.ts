import { writeFileSync } from "fs";
import { resolve } from "path";
import { createApp } from "../src/api/app.js";

// Stub deps — only needed to instantiate the router; no actual DB calls happen at startup
const noop = () => { throw new Error("stub"); };
const storeStub = new Proxy({} as Parameters<typeof createApp>[0]["store"], {
  get: () => noop,
});
const authStub: Parameters<typeof createApp>[0]["auth"] = {
  validateToken: noop as never,
};

const app = createApp({ store: storeStub, auth: authStub });

const spec = app.getOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "SES Email Adapter", version: "1.0.0" },
});

const outPath = resolve(process.cwd(), "openapi.json");
writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outPath}`);
