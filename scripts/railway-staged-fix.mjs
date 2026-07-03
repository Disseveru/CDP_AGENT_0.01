#!/usr/bin/env node
/**
 * Resolve stuck Railway staged changes (duplicate volume mounts, APPLYING wedge).
 *
 * Usage:
 *   RAILWAY_TOKEN=... npm run railway:staged-fix
 *   RAILWAY_TOKEN=... npm run railway:staged-fix -- --apply
 */
import { parseArgs } from "node:util";

const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";
const PROJECT_ID = "2d961fd8-a0a9-4ae6-93e1-3e209858e7f2";
const ENVIRONMENT_ID = "5a065ed8-6c1b-4aa6-8968-7f5f3804c868";
const SERVICE_ID = "0baa1261-4e18-4216-9377-e24e77655561";
const MOUNT_PATH = "/app/gas-oracle-mcp/data";

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
  },
});

async function gql(token, query, variables) {
  const res = await fetch(RAILWAY_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }
  return body.data;
}

function volumeIdsFromPatch(patch) {
  const ids = new Set();
  for (const id of Object.keys(patch?.volumes || {})) ids.add(id);
  const mounts = patch?.services?.[SERVICE_ID]?.volumeMounts || {};
  for (const id of Object.keys(mounts)) ids.add(id);
  return [...ids];
}

async function listVolumeInstances(token) {
  const data = await gql(
    token,
    `query($environmentId: String!) {
      environment(id: $environmentId) {
        volumeInstances {
          edges {
            node { id volumeId serviceId mountPath state volume { id name } }
          }
        }
      }
    }`,
    { environmentId: ENVIRONMENT_ID },
  );
  return data.environment.volumeInstances.edges.map((edge) => edge.node);
}

async function listProjectVolumes(token) {
  const data = await gql(
    token,
    `query($projectId: String!) {
      project(id: $projectId) { volumes { edges { node { id name } } } }
    }`,
    { projectId: PROJECT_ID },
  );
  return data.project.volumes.edges.map((edge) => edge.node);
}

async function deleteOrphanVolumes(token, patchVolumeIds, instances, projectVolumes) {
  const mountedIds = new Set(instances.map((instance) => instance.volumeId));
  const primaryMcp = instances.find(
    (instance) => instance.serviceId === SERVICE_ID && instance.mountPath === MOUNT_PATH,
  );

  for (const volumeId of patchVolumeIds) {
    if (mountedIds.has(volumeId)) continue;
    if (primaryMcp && volumeId === primaryMcp.volumeId) continue;
    const known = projectVolumes.find((volume) => volume.id === volumeId);
    if (!known) continue;
    await gql(
      token,
      `mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`,
      { volumeId },
    );
    console.log(`Deleted orphan volume ${known.name} (${volumeId})`);
  }
}

async function clearStagedUi(token, staged) {
  const patchVolumeIds = volumeIdsFromPatch(staged.patch);
  if (patchVolumeIds.length === 0) {
    await gql(
      token,
      `mutation($environmentId: String!, $input: EnvironmentConfig!) {
        environmentStageChanges(environmentId: $environmentId, input: $input, merge: false) { id status }
      }`,
      { environmentId: ENVIRONMENT_ID, input: {} },
    );
    await gql(
      token,
      `mutation($environmentId: String!) {
        environmentPatchCommitStaged(
          environmentId: $environmentId
          commitMessage: "Clear empty staged changes"
          skipDeploys: true
        )
      }`,
      { environmentId: ENVIRONMENT_ID },
    );
    console.log("Committed empty staged patch (skipDeploys=true).");
    return;
  }

  for (const volumeId of patchVolumeIds) {
    try {
      await gql(
        token,
        `mutation($environmentId: String!, $patch: EnvironmentConfig!) {
          environmentPatchCommit(
            environmentId: $environmentId
            patch: $patch
            commitMessage: "Delete orphan volume from stuck staged change"
          )
        }`,
        {
          environmentId: ENVIRONMENT_ID,
          patch: { volumes: { [volumeId]: { isDeleted: true } } },
        },
      );
      console.log(`Marked volume ${volumeId} deleted in environment config.`);
    } catch (error) {
      console.log(`Could not commit isDeleted for ${volumeId}: ${error.message}`);
    }
  }

  await gql(
    token,
    `mutation($environmentId: String!, $input: JSON!) {
      environmentApplyChangeSet(
        environmentId: $environmentId
        input: $input
        commitMessage: "Flush Railway staged-change worker"
      ) { id status diagnostics }
    }`,
    { environmentId: ENVIRONMENT_ID, input: { version: 1, patches: [] } },
  );
  console.log("Sent no-op change set to Railway.");
}

async function main() {
  const token = process.env.RAILWAY_TOKEN?.trim();
  if (!token) throw new Error("RAILWAY_TOKEN is required.");

  const stagedData = await gql(
    token,
    `query($environmentId: String!) {
      environmentStagedChanges(environmentId: $environmentId) {
        id status message patch lastAppliedError appliedAt
      }
    }`,
    { environmentId: ENVIRONMENT_ID },
  );
  const staged = stagedData.environmentStagedChanges;

  console.log("Railway staged changes:");
  console.log(JSON.stringify(staged, null, 2));

  if (!staged?.id) {
    console.log("No staged changes.");
    return;
  }

  if (staged.status === "APPLIED" || staged.status === "COMMITTED") {
    console.log("Staged changes already settled.");
    return;
  }

  const instances = await listVolumeInstances(token);
  const projectVolumes = await listProjectVolumes(token);
  const mcpMount = instances.find(
    (instance) => instance.serviceId === SERVICE_ID && instance.mountPath === MOUNT_PATH,
  );
  if (mcpMount) {
    console.log(`MCP volume OK: ${mcpMount.volume.name} (${mcpMount.volumeId}) state=${mcpMount.state}`);
  } else {
    console.log("WARNING: MCP volume mount missing — run npm run railway:provision");
  }

  if (!args.apply) {
    console.log("");
    console.log("Dry run only. Re-run with --apply to delete orphan volumes and nudge Railway.");
    if (staged.status === "APPLYING") {
      console.log("If the dashboard still shows Applying N changes, open the project and discard them:");
      console.log(`  https://railway.com/project/${PROJECT_ID}`);
    }
    return;
  }

  const patchVolumeIds = volumeIdsFromPatch(staged.patch);
  await deleteOrphanVolumes(token, patchVolumeIds, instances, projectVolumes);
  await clearStagedUi(token, staged);

  const after = await gql(
    token,
    `query($environmentId: String!) {
      environmentStagedChanges(environmentId: $environmentId) { id status lastAppliedError appliedAt }
    }`,
    { environmentId: ENVIRONMENT_ID },
  );
  console.log("");
  console.log("Staged changes after fix:");
  console.log(JSON.stringify(after.environmentStagedChanges, null, 2));

  if (after.environmentStagedChanges?.status === "APPLYING") {
    console.log("");
    console.log("Railway still reports APPLYING — discard the change in the dashboard UI:");
    console.log(`  https://railway.com/project/${PROJECT_ID}`);
    console.log("Inspect banner → click X on each pending volume change.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
