/** Environment keys used to detect managed public deployments. */
export type DeployEnv = Partial<
  Pick<NodeJS.ProcessEnv, "RAILWAY_ENVIRONMENT" | "RENDER" | "RENDER_SERVICE_TYPE">
>;

/**
 * True on Railway production or Render web services — platforms where the MCP
 * server is exposed on the public internet without local dev safeguards.
 */
export function isManagedProductionDeploy(env: DeployEnv = process.env): boolean {
  if (env.RAILWAY_ENVIRONMENT === "production") return true;
  if (env.RENDER === "true" && env.RENDER_SERVICE_TYPE === "web") return true;
  return false;
}
