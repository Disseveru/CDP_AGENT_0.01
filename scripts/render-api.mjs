/**
 * Shared Render REST API helpers.
 * Docs: https://api.render.com/docs
 */

const RENDER_API_BASE = "https://api.render.com/v1";

export function getRenderApiKey() {
  return (
    process.env.RENDER_API_KEY?.trim() ||
    process.env.RENDER_TOKEN?.trim() ||
    process.env.RENDER_API_TOKEN?.trim() ||
    ""
  );
}

export async function renderFetch(path, options = {}) {
  const apiKey = getRenderApiKey();
  if (!apiKey) {
    throw new Error(
      "RENDER_API_KEY is unset. Create one in Render → Account Settings → API Keys.",
    );
  }

  const res = await fetch(`${RENDER_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail =
      typeof body === "object" && body?.message
        ? body.message
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    throw new Error(`Render API ${res.status} ${options.method || "GET"} ${path}: ${detail}`);
  }

  return body;
}

/** Paginate list endpoints that return `{ cursor }` items. */
export async function renderList(path) {
  const items = [];
  let cursor = null;

  do {
    const suffix = cursor ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : "";
    const page = await renderFetch(`${path}${suffix}`);
    if (!Array.isArray(page)) {
      return page;
    }
    for (const entry of page) {
      items.push(entry);
      if (entry?.cursor) cursor = entry.cursor;
    }
    if (!page.length || !page.at(-1)?.cursor) break;
    cursor = page.at(-1).cursor;
  } while (cursor);

  return items;
}

export async function listServices() {
  const rows = await renderList("/services?limit=100");
  return rows
    .map((row) => row.service ?? row)
    .filter((service) => service?.id);
}

export async function findService({ name, url }) {
  const services = await listServices();
  const normalizedUrl = url?.replace(/\/$/, "").toLowerCase();

  for (const service of services) {
    const serviceUrl = service.serviceDetails?.url?.replace(/\/$/, "").toLowerCase();
    if (normalizedUrl && serviceUrl === normalizedUrl) return service;
    if (name && service.name?.toLowerCase() === name.toLowerCase()) return service;
    if (normalizedUrl && serviceUrl && normalizedUrl.includes(serviceUrl.replace("https://", ""))) {
      return service;
    }
  }

  return null;
}

export async function getEnvVars(serviceId) {
  const rows = await renderList(`/services/${serviceId}/env-vars?limit=100`);
  const vars = {};
  for (const row of rows) {
    const envVar = row.envVar ?? row;
    if (envVar?.key) vars[envVar.key] = envVar.value ?? "";
  }
  return vars;
}

/**
 * Replace all env vars for a service. Render removes any key omitted from the body.
 * Pass the full merged map.
 */
export async function putEnvVars(serviceId, vars) {
  const body = Object.entries(vars)
    .filter(([key]) => key?.trim())
    .map(([key, value]) => ({ key, value: String(value) }));
  return renderFetch(`/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function triggerDeploy(serviceId, { clearCache = false } = {}) {
  return renderFetch(`/services/${serviceId}/deploys`, {
    method: "POST",
    body: JSON.stringify(clearCache ? { clearCache: "clear" } : {}),
  });
}

export function servicePublicUrl(service) {
  return service?.serviceDetails?.url?.replace(/\/$/, "") || null;
}
