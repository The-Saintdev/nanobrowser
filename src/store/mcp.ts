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
  tools: McpToolInfo[];
  lastSyncedAt?: string;
  lastError?: string;
}

export interface McpServerSecret {
  authType: McpAuthType;
  token?: string;
  headerName?: string;
}

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
