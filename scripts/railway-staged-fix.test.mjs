import assert from "node:assert/strict";
import test from "node:test";

import { shouldSkipVolumeId, volumeIdsFromPatch } from "./railway-staged-fix.mjs";

const SERVICE_ID = "0baa1261-4e18-4216-9377-e24e77655561";
const MOUNT_PATH = "/app/gas-oracle-mcp/data";
const PRIMARY_VOLUME = "vol-primary";
const ORPHAN_VOLUME = "vol-orphan";

const instances = [
  {
    volumeId: PRIMARY_VOLUME,
    serviceId: SERVICE_ID,
    mountPath: MOUNT_PATH,
    state: "READY",
  },
];

test("volumeIdsFromPatch collects volume and mount ids", () => {
  const patch = {
    volumes: { [ORPHAN_VOLUME]: {}, [PRIMARY_VOLUME]: {} },
    services: {
      [SERVICE_ID]: {
        volumeMounts: {
          [ORPHAN_VOLUME]: { mountPath: MOUNT_PATH },
        },
      },
    },
  };

  const ids = volumeIdsFromPatch(patch, SERVICE_ID).sort();
  assert.deepEqual(ids, [ORPHAN_VOLUME, PRIMARY_VOLUME].sort());
});

test("shouldSkipVolumeId protects mounted and primary MCP volumes", () => {
  assert.equal(shouldSkipVolumeId(PRIMARY_VOLUME, instances, SERVICE_ID, MOUNT_PATH), true);
  assert.equal(shouldSkipVolumeId(ORPHAN_VOLUME, instances, SERVICE_ID, MOUNT_PATH), false);
});

test("shouldSkipVolumeId protects in-progress mounts, not only READY", () => {
  const creating = [
    {
      volumeId: PRIMARY_VOLUME,
      serviceId: SERVICE_ID,
      mountPath: MOUNT_PATH,
      state: "CREATING",
    },
  ];
  assert.equal(shouldSkipVolumeId(PRIMARY_VOLUME, creating, SERVICE_ID, MOUNT_PATH), true);
});
