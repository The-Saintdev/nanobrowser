import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthHeaders,
  buildMcpAgentTools,
  clearMcpSessions,
  fetchServerTools,
  formatMcpCallResult,
  invokeMcpTool,
  normalizeToolSchema,
  parseSseJsonRpc,
  sanitizeToolName,
} from '../mcp-client';
import type { McpServerConfig } from '@src/store/mcp';

afterEach(() => {
  clearMcpSessions();
});

describe('mcp-client', () => {
  it('builds auth headers for bearer, x-api-key, and custom headers', () => {
    expect(buildAuthHeaders(undefined)).toEqual({});
    expect(buildAuthHeaders({ authType: 'none', token: 'abc' })).toEqual({});
    expect(buildAuthHeaders({ authType: 'bearer', token: 'tok_1' })).toEqual({ Authorization: 'Bearer tok_1' });
    expect(buildAuthHeaders({ authType: 'x-api-key', token: 'key_1' })).toEqual({ 'x-api-key': 'key_1' });
    expect(buildAuthHeaders({ authType: 'custom', headerName: 'X-Custom', token: 'val_1' })).toEqual({
      'X-Custom': 'val_1',
    });
  });

  it('normalizes tool schemas and strips $schema', () => {
    expect(
      normalizeToolSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      }),
    ).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(normalizeToolSchema(undefined)).toEqual({ type: 'object', properties: {} });
  });

  it('sanitizes tool names under 64 chars and resolves collisions', () => {
    const used = new Set<string>();
    const a = sanitizeToolName('SaintStack', 'saintstack_search_memory', used);
    const b = sanitizeToolName('SaintStack', 'saintstack_search_memory', used);
    const c = sanitizeToolName(
      'Very Long Server Name Here',
      'very_long_remote_tool_name_exceeding_sixty_four_chars_total',
      used,
    );
    expect(a).toBe('mcp_saintstack_saintstack_search_memory');
    expect(b).toBe('mcp_saintstack_saintstack_search_memory_2');
    expect(c.length).toBeLessThanOrEqual(64);
    expect(/^[a-zA-Z0-9_-]+$/.test(c)).toBe(true);
  });

  it('parses SSE event-stream JSON-RPC frames cleanly', () => {
    const sse = [
      ': ping',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":42,"result":{"content":[{"type":"text","text":"hello"}]}}',
      '',
    ].join('\n');
    expect(parseSseJsonRpc(sse, 42)).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { content: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('discovers tools over Streamable HTTP with session IDs and pagination', async () => {
    const seenMethods: string[] = [];
    const seenSessions: Array<string | null> = [];
    let reqCount = 0;

    const fakeFetch: typeof fetch = async (_input, init) => {
      reqCount++;
      const headers = new Headers(init?.headers);
      seenSessions.push(headers.get('Mcp-Session-Id'));
      expect(headers.get('Authorization')).toBe('Bearer saint_test');
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { cursor?: string } };
      seenMethods.push(body.method);

      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { capabilities: {} } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-123' },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (body.method === 'tools/list' && !body.params?.cursor) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'search_memory',
                  description: 'Search saved knowledge',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                  annotations: { readOnlyHint: true },
                },
              ],
              nextCursor: 'p2',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{ name: 'save_decision', description: 'Record decision', inputSchema: { type: 'object' } }],
          },
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    };

    const tools = await fetchServerTools(
      'https://saintstack.crescoafrica.com/mcp',
      { authType: 'bearer', token: 'saint_test' },
      { fetch: fakeFetch },
    );

    expect(reqCount).toBe(4);
    expect(seenMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(seenSessions).toEqual([null, 'sess-123', 'sess-123', 'sess-123']);
    expect(tools).toEqual([
      {
        name: 'search_memory',
        description: 'Search saved knowledge',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        readOnly: true,
      },
      {
        name: 'save_decision',
        description: 'Record decision',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
  });

  it('builds read/mutate AgentTool kinds and re-initializes if session expires', async () => {
    const server: McpServerConfig = {
      id: 'srv-1',
      name: 'SaintStack',
      url: 'https://saintstack.crescoafrica.com/mcp',
      enabled: true,
      tools: [
        { name: 'search_memory', description: 'Search', inputSchema: { type: 'object' }, readOnly: true },
        { name: 'save_session', description: 'Save', inputSchema: { type: 'object' } },
      ],
    };
    const { agentTools, bindings } = buildMcpAgentTools([server], {
      'srv-1': { authType: 'bearer', token: 't1' },
    });

    expect(agentTools.map(t => ({ name: t.name, kind: t.kind, source: t.source }))).toEqual([
      { name: 'mcp_saintstack_search_memory', kind: 'read', source: 'agent' },
      { name: 'mcp_saintstack_save_session', kind: 'mutate', source: 'agent' },
    ]);

    const binding = bindings.get('mcp_saintstack_search_memory')!;
    let callNum = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      callNum++;
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': `s-${callNum}` },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      const sid = new Headers(init?.headers).get('Mcp-Session-Id');
      if (sid === 's-1') {
        return new Response('session expired', { status: 404 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'Found decision #1' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const result = await invokeMcpTool(binding, { query: 'oauth' }, { fetch: fakeFetch });
    expect(result).toEqual({ text: 'Found decision #1', isError: false });
  });

  it('formats structured and error MCP results', () => {
    expect(formatMcpCallResult({ isError: true, content: [{ type: 'text', text: 'Unauthorized' }] })).toEqual({
      text: 'Unauthorized',
      isError: true,
    });
    expect(formatMcpCallResult({ structuredContent: { ok: true, count: 2 } })).toEqual({
      text: '{\n  "ok": true,\n  "count": 2\n}',
      isError: false,
    });
  });
});
