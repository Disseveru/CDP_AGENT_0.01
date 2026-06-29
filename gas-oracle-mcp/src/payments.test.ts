import assert from "node:assert/strict";
import test from "node:test";

import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";

import {
  buildCaptchaSubmitRouteConfig,
  buildDiscoveryRouteConfig,
  buildDiscoveryExtension,
  DISCOVERY_QUERY_INPUT_EXAMPLE,
  JSON_SCHEMA_DRAFT,
  schemaFromExample,
} from "./payments.js";

test("buildDiscoveryRouteConfig matches Agentic Market wizard shape", () => {
  const payTo = "0xed7d30e8bc643503f9da261ed8e623bb6ecf6189";
  const config = buildDiscoveryRouteConfig(payTo);

  assert.equal(config.resource?.endsWith("/"), true);
  assert.ok(config.extensions?.bazaar);

  const bazaar = (config.extensions as { bazaar: Record<string, unknown> }).bazaar;
  const validation = validateDiscoveryExtensionSpec(bazaar);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const info = (bazaar as { info?: { input?: Record<string, unknown> } }).info;
  assert.equal(info?.input?.type, "http");
  assert.deepEqual(info?.input?.queryParams, DISCOVERY_QUERY_INPUT_EXAMPLE);

  const outputExample = (bazaar as { info?: { output?: { example?: { payTo?: string } } } }).info
    ?.output?.example;
  assert.equal(outputExample?.payTo, payTo);
});

test("buildCaptchaSubmitRouteConfig includes output schema", () => {
  const config = buildCaptchaSubmitRouteConfig("0x0000000000000000000000000000000000000001");
  const bazaar = (config.extensions as { bazaar: Record<string, unknown> }).bazaar;
  const validation = validateDiscoveryExtensionSpec(bazaar);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});

test("buildDiscoveryExtension includes MCP output schema from example", () => {
  const extensions = buildDiscoveryExtension({
    toolName: "peek_inbox",
    description: "Peek inbox events",
    inputSchema: {
      type: "object",
      properties: { inboxId: { type: "string" }, secret: { type: "string" } },
      required: ["inboxId", "secret"],
    },
    example: { inboxId: "abc", secret: "secret" },
    outputExample: { pending: 1, events: [] },
  });

  const bazaar = (extensions as { bazaar: Record<string, unknown> }).bazaar;
  const validation = validateDiscoveryExtensionSpec(bazaar);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});

test("schemaFromExample infers object property types", () => {
  const schema = schemaFromExample({ status: "ready", count: 3 });
  assert.equal(schema.$schema, JSON_SCHEMA_DRAFT);
  assert.equal((schema.properties as Record<string, { type: string }>).status.type, "string");
  assert.equal((schema.properties as Record<string, { type: string }>).count.type, "number");
});
