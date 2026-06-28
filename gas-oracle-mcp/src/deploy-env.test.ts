import assert from "node:assert/strict";
import test from "node:test";

import { isManagedProductionDeploy } from "./deploy-env.js";

test("isManagedProductionDeploy detects Railway production", () => {
  assert.equal(
    isManagedProductionDeploy({ RAILWAY_ENVIRONMENT: "production" }),
    true,
  );
  assert.equal(
    isManagedProductionDeploy({ RAILWAY_ENVIRONMENT: "staging" }),
    false,
  );
});

test("isManagedProductionDeploy detects Render web services", () => {
  assert.equal(
    isManagedProductionDeploy({ RENDER: "true", RENDER_SERVICE_TYPE: "web" }),
    true,
  );
  assert.equal(
    isManagedProductionDeploy({ RENDER: "true", RENDER_SERVICE_TYPE: "worker" }),
    false,
  );
  assert.equal(isManagedProductionDeploy({ RENDER: "true" }), false);
});

test("isManagedProductionDeploy is false for local dev defaults", () => {
  assert.equal(isManagedProductionDeploy({}), false);
});
