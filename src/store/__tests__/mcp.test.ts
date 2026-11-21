import { beforeEach, describe, expect, it } from 'vitest';
import {
  mcpSecretsStorage,
  mcpServerSlug,
  mcpServersStorage,
  normalizeMcpUrl,
  parseMcpJsonImport,
  removeMcpServer,
  upsertMcpServer,
} from '../mcp';

function installFakeChromeStorage() {
  const localData: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.map(k => [k, localData[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(localData, items),
        onChanged: { addListener: () => undefined },
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        onChanged: { addListener: () => undefined },
      },
    },
  };
  return localData;
}

describe('mcp store helpers', () => {
  let backing: Record<string, unknown>;

  beforeEach(() => {
    backing = installFakeChromeStorage();
  });

  it('validates http and https URLs and rejects other schemes', () => {
    expect(normalizeMcpUrl(' https://saintstack.crescoafrica.com/mcp ')).toBe(
      'https://saintstack.crescoafrica.com/mcp',
    );
    expect(normalizeMcpUrl('http://localhost:8787/mcp')).toBe('http://localhost:8787/mcp');
    expect(normalizeMcpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeMcpUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeMcpUrl('not a url')).toBeNull();
  });

  it('builds deterministic lowercase slugs', () => {
    expect(mcpServerSlug('SaintStack Prod!')).toBe('saintstack_prod');
    expect(mcpServerSlug('---')).toBe('server');
  });

  it('stores servers, autoApprove, and secrets separately and removes both cleanly', async () => {
    await upsertMcpServer(
      {
        id: 's1',
        name: 'SaintStack',
        url: 'https://saintstack.crescoafrica.com/mcp',
        enabled: true,
        autoApprove: true,
        tools: [{ name: 'search', description: 'Search memory', inputSchema: { type: 'object', properties: {} } }],
      },
      { authType: 'bearer', token: 'secret-token' },
    );

    const servers = await mcpServersStorage.get();
    const secrets = await mcpSecretsStorage.get();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('SaintStack');
    expect(servers[0]?.autoApprove).toBe(true);
    expect(secrets.s1).toEqual({ authType: 'bearer', token: 'secret-token' });
    expect(JSON.stringify(backing['nb.mcpServers'])).not.toContain('secret-token');

    await removeMcpServer('s1');
    expect(await mcpServersStorage.get()).toEqual([]);
    expect(await mcpSecretsStorage.get()).toEqual({});
  });

  it('parses OpenCode JSON configs while skipping local stdio servers', () => {
    const parsed = parseMcpJsonImport(
      JSON.stringify({
        mcp: {
          servers: {
            browse: {
              type: 'local',
              command: ['C:\\Users\\Hp\\.local\\bin\\browse.exe', 'mcp'],
            },
            saintstack: {
              type: 'remote',
              url: 'https://saintstack.crescoafrica.com/mcp',
              headers: {
                Authorization: 'Bearer saint_sec_123',
              },
            },
          },
        },
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      skippedLocal: ['browse'],
      servers: [
        {
          name: 'saintstack',
          url: 'https://saintstack.crescoafrica.com/mcp',
          enabled: true,
          secret: { authType: 'bearer', token: 'saint_sec_123' },
        },
      ],
    });
  });

  it('parses Claude mcpServers and standalone server JSON configs', () => {
    const claude = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          customSrv: {
            url: 'https://example.com/mcp',
            headers: { 'x-api-key': 'k_123' },
            autoApprove: true,
          },
        },
      }),
    );
    expect(claude).toEqual({
      ok: true,
      skippedLocal: [],
      servers: [
        {
          name: 'customSrv',
          url: 'https://example.com/mcp',
          enabled: true,
          autoApprove: true,
          secret: { authType: 'x-api-key', token: 'k_123' },
        },
      ],
    });

    const single = parseMcpJsonImport(
      JSON.stringify({
        url: 'https://api.example.org/mcp',
        headers: { 'X-Token': 'abc' },
      }),
    );
    expect(single).toEqual({
      ok: true,
      skippedLocal: [],
      servers: [
        {
          name: 'api.example.org',
          url: 'https://api.example.org/mcp',
          enabled: true,
          secret: { authType: 'custom', headerName: 'X-Token', token: 'abc' },
        },
      ],
    });

    expect(parseMcpJsonImport('not json').ok).toBe(false);
  });
});
