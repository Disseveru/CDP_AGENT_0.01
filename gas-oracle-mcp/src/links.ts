/**
 * Link extraction from public web pages for research agents.
 */
import { fetchRawContent } from "./fetch.js";

export interface ExtractLinksInput {
  url: string;
  /** When true, only return links on the same hostname as the page. */
  sameOrigin?: boolean;
  /** Maximum number of links to return (default 100). */
  limit?: number;
}

export interface ExtractLinksResult {
  timestamp: string;
  url: string;
  finalUrl: string;
  status: number;
  title: string | null;
  linkCount: number;
  links: Array<{ href: string; text: string | null }>;
  extractedInMs: number;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].replace(/\s+/g, " ").trim()) : null;
}

function extractAnchorLinks(html: string, baseUrl: URL): Array<{ href: string; text: string | null }> {
  const links: Array<{ href: string; text: string | null }> = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawHref = (match[1] || match[2] || match[3] || "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) {
      continue;
    }

    let resolved: string;
    try {
      resolved = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }

    if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const text = decodeEntities(match[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || null;
    links.push({ href: resolved, text });
  }

  return links;
}

/** Fetches a page and extracts anchor links for agent research workflows. */
export async function extractLinks(input: ExtractLinksInput): Promise<ExtractLinksResult> {
  const started = Date.now();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);

  const fetched = await fetchRawContent({ url: input.url });
  const baseUrl = new URL(fetched.finalUrl);
  const title = extractTitle(fetched.raw);
  let links = extractAnchorLinks(fetched.raw, baseUrl);

  if (input.sameOrigin) {
    links = links.filter((link) => {
      try {
        return new URL(link.href).hostname === baseUrl.hostname;
      } catch {
        return false;
      }
    });
  }

  return {
    timestamp: new Date().toISOString(),
    url: input.url,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    title,
    linkCount: links.length,
    links: links.slice(0, limit),
    extractedInMs: Date.now() - started,
  };
}
