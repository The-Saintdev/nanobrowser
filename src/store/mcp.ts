// MCP (Model Context Protocol) server configurations and credentials, stored separately like providers and keys so
// secrets never leave the browser in metadata exports.
import { createStorage } from './storage';

export type McpAuthType = 'none' | 'bearer' | 'x-api-key' | 'custom';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when the remote tool advertises `annotations.readOnlyHint === true`. */
  readOnly?: boolean;
}

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** When true, non-read-only MCP tools from this server run in Ask mode without a confirmation card. */
  autoApprove?: boolean;
  tools: McpToolInfo[];
  lastSyncedAt?: string;
  lastError?: string;
}

export interface McpServerSecret {
  authType: McpAuthType;
  token?: string;
  headerName?: string;
}

export interface ParsedMcpEntry {
  name: string;
  url: string;
  enabled: boolean;
  autoApprove?: boolean;
  secret: McpServerSecret;
}

export type McpJsonImportResult =
  { ok: true; servers: ParsedMcpEntry[]; skippedLocal: string[] } | { ok: false; error: string };

export const MCP_SERVERS_KEY = 'nb.mcpServers';
export const MCP_SECRETS_KEY = 'nb.mcpSecrets';

/** Normalizes and validates an MCP endpoint URL (http:// or https:// only). */
export function normalizeMcpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Stable lowercase slug from a server name or id for tool namespacing. */
export function mcpServerSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return slug || 'server';
}

function extractSecretFromHeaders(rawHeaders: unknown): McpServerSecret {
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    return { authType: 'none' };
  }
  const entries = Object.entries(rawHeaders as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
  );
  for (const [key, val] of entries) {
    if (key.toLowerCase() === 'authorization') {
      const trimmed = val.trim();
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
      if (bearerMatch) return { authType: 'bearer', token: bearerMatch[1].trim() };
      return { authType: 'custom', headerName: key, token: trimmed };
    }
  }
  for (const [key, val] of entries) {
    if (key.toLowerCase() === 'x-api-key') {
      return { authType: 'x-api-key', token: val.trim() };
    }
  }
  if (entries.length > 0) {
    const [headerName, token] = entries[0];
    return { authType: 'custom', headerName: headerName.trim(), token: token.trim() };
  }
  return { authType: 'none' };
}

/**
 * Parses OpenCode (`mcp.servers`), Claude/Cursor (`mcpServers`), `servers`, or standalone server JSON into
 * remote MCP server entries. Local stdio entries are skipped gracefully and listed in `skippedLocal`.
 */
export function parseMcpJsonImport(raw: string): McpJsonImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a JSON object containing MCP server configuration.' };
  }

  const obj = parsed as Record<string, unknown>;
  let map: Record<string, unknown> | undefined;

  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(obj.mcp) && isObj(obj.mcp.servers)) {
    map = obj.mcp.servers;
  } else if (isObj(obj.mcpServers)) {
    map = obj.mcpServers;
  } else if (isObj(obj.servers)) {
    map = obj.servers;
  } else if (typeof obj.url === 'string' || typeof obj.serverUrl === 'string') {
    const rawUrl = (typeof obj.url === 'string' ? obj.url : obj.serverUrl) as string;
    const normalized = normalizeMcpUrl(rawUrl);
    if (!normalized) return { ok: false, error: 'Invalid http:// or https:// MCP server URL.' };
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : new URL(normalized).host;
    return {
      ok: true,
      servers: [
        {
          name,
          url: normalized,
          enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
          ...(obj.autoApprove === true ? { autoApprove: true } : {}),
          secret: extractSecretFromHeaders(obj.headers),
        },
      ],
      skippedLocal: [],
    };
  } else {
    map = obj;
  }

  const servers: ParsedMcpEntry[] = [];
  const skippedLocal: string[] = [];

  for (const [key, value] of Object.entries(map)) {
    if (!isObj(value)) continue;
    const rawUrl =
      typeof value.url === 'string'
        ? value.url
        : typeof value.serverUrl === 'string'
          ? value.serverUrl
          : typeof value.endpoint === 'string'
            ? value.endpoint
            : undefined;
    if (
      value.type === 'local' ||
      (!rawUrl && Array.isArray(value.command)) ||
      (!rawUrl && typeof value.command === 'string')
    ) {
      skippedLocal.push(key);
      continue;
    }
    if (!rawUrl) continue;
    const normalized = normalizeMcpUrl(rawUrl);
    if (!normalized) continue;
    servers.push({
      name:
        typeof value.name === 'string' && value.name.trim()
          ? value.name.trim()
          : key.trim() || new URL(normalized).host,
      url: normalized,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      ...(value.autoApprove === true ? { autoApprove: true } : {}),
      secret: extractSecretFromHeaders(value.headers),
    });
  }

  return { ok: true, servers, skippedLocal };
}

function mergeServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<McpServerConfig>;
    const url = typeof s.url === 'string' ? normalizeMcpUrl(s.url) : null;
    if (typeof s.id !== 'string' || !s.id || typeof s.name !== 'string' || !url) continue;
    const tools: McpToolInfo[] = Array.isArray(s.tools)
      ? s.tools.filter(
          (t): t is McpToolInfo =>
            !!t &&
            typeof t === 'object' &&
            typeof t.name === 'string' &&
            t.name.length > 0 &&
            typeof t.description === 'string' &&
            !!t.inputSchema &&
            typeof t.inputSchema === 'object',
        )
      : [];
    out.push({
      id: s.id,
      name: s.name.trim() || url,
      url,
      enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
      ...(s.autoApprove === true ? { autoApprove: true } : {}),
      tools,
      ...(typeof s.lastSyncedAt === 'string' ? { lastSyncedAt: s.lastSyncedAt } : {}),
      ...(typeof s.lastError === 'string' ? { lastError: s.lastError } : {}),
    });
  }
  return out;
}

function mergeSecrets(raw: unknown): Record<string, McpServerSecret> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, McpServerSecret> = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const v = val as Partial<McpServerSecret>;
    const authType: McpAuthType =
      v.authType === 'bearer' || v.authType === 'x-api-key' || v.authType === 'custom' ? v.authType : 'none';
    out[id] = {
      authType,
      ...(typeof v.token === 'string' && v.token ? { token: v.token } : {}),
      ...(typeof v.headerName === 'string' && v.headerName.trim() ? { headerName: v.headerName.trim() } : {}),
    };
  }
  return out;
}

export const mcpServersStorage = createStorage<McpServerConfig[]>(MCP_SERVERS_KEY, [], {
  liveUpdate: true,
  merge: mergeServers,
});

export const mcpSecretsStorage = createStorage<Record<string, McpServerSecret>>(
  MCP_SECRETS_KEY,
  {},
  {
    liveUpdate: true,
    merge: mergeSecrets,
  },
);

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return mcpServersStorage.get();
}

export async function upsertMcpServer(server: McpServerConfig, secret?: McpServerSecret): Promise<void> {
  await mcpServersStorage.set(prev => {
    const idx = prev.findIndex(s => s.id === server.id);
    if (idx === -1) return [...prev, server];
    const next = [...prev];
    next[idx] = server;
    return next;
  });
  if (secret !== undefined) {
    await mcpSecretsStorage.set(prev => ({ ...prev, [server.id]: secret }));
  }
}

export async function removeMcpServer(id: string): Promise<void> {
  await mcpServersStorage.set(prev => prev.filter(s => s.id !== id));
  await mcpSecretsStorage.set(prev => {
    const next = { ...prev };
    delete next[id];
    return next;
  });
}
