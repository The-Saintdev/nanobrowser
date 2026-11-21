// Streamable HTTP MCP client for Chrome extensions: discovers remote MCP tools (`initialize` + `tools/list`),
// normalizes JSON schemas for the LLM layer, and executes `tools/call` requests with optional auth headers.
import type { AgentTool } from '@src/agent/tools';
import { mcpServerSlug, normalizeMcpUrl } from '@src/store/mcp';
import type { McpServerConfig, McpServerSecret, McpToolInfo } from '@src/store/mcp';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_DISCOVER_TIMEOUT_MS = 12_000;
const DEFAULT_CALL_TIMEOUT_MS = 25_000;
const MAX_TOOL_LIST_PAGES = 20;

export interface McpClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpToolBinding {
  publicName: string;
  remoteName: string;
  server: McpServerConfig;
  secret?: McpServerSecret;
  readOnly: boolean;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpSessionState {
  sessionId?: string;
}

const sessionCache = new Map<string, McpSessionState>();

/** Builds HTTP headers for an MCP request from the server's secret configuration. */
export function buildAuthHeaders(secret?: McpServerSecret): Record<string, string> {
  if (!secret || secret.authType === 'none') return {};
  const token = secret.token?.trim();
  if (!token) return {};
  if (secret.authType === 'bearer') return { Authorization: `Bearer ${token}` };
  if (secret.authType === 'x-api-key') return { 'x-api-key': token };
  if (secret.authType === 'custom') {
    const name = secret.headerName?.trim();
    if (!name || /[\r\n:]/.test(name)) return {};
    return { [name]: token };
  }
  return {};
}

/** Normalizes remote MCP tool schemas into JSON Schema objects accepted across LLM providers. */
export function normalizeToolSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { type: 'object', properties: {} };
  }
  const copy: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  // Gemini / Vertex APIs reject external JSON Schema `$schema` URIs on tool definitions.
  delete copy.$schema;
  if (!copy.type) copy.type = 'object';
  if (copy.type === 'object' && (!copy.properties || typeof copy.properties !== 'object')) {
    copy.properties = {};
  }
  return copy;
}

/** Sanitizes a remote MCP server + tool name into a provider-safe tool identifier (max 64 chars). */
export function sanitizeToolName(serverName: string, remoteToolName: string, used: Set<string>): string {
  const serverPart = mcpServerSlug(serverName).slice(0, 18);
  const toolPart = remoteToolName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const base = `mcp_${serverPart}_${toolPart}`.slice(0, 64);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base.slice(0, 55)}_${Date.now().toString(36).slice(-7)}`;
  used.add(fallback);
  return fallback;
}

/** Builds AgentTool definitions and dispatch bindings from enabled MCP servers. */
export function buildMcpAgentTools(
  servers: readonly McpServerConfig[],
  secrets: Record<string, McpServerSecret>,
): { agentTools: AgentTool[]; bindings: Map<string, McpToolBinding> } {
  const agentTools: AgentTool[] = [];
  const bindings = new Map<string, McpToolBinding>();
  const used = new Set<string>();

  for (const server of servers) {
    if (!server.enabled) continue;
    const secret = secrets[server.id];
    for (const tool of server.tools) {
      const publicName = sanitizeToolName(server.name, tool.name, used);
      const readOnly = tool.readOnly === true;
      agentTools.push({
        name: publicName,
        description: `[MCP: ${server.name}] ${tool.description || tool.name}`,
        parameters: normalizeToolSchema(tool.inputSchema),
        source: 'agent',
        group: 'working',
        kind: readOnly ? 'read' : 'mutate',
      });
      bindings.set(publicName, {
        publicName,
        remoteName: tool.name,
        server,
        secret,
        readOnly,
      });
    }
  }

  return { agentTools, bindings };
}

/** Parses `text/event-stream` payloads returned by Streamable HTTP MCP servers. */
export function parseSseJsonRpc(body: string, expectedId: string | number): JsonRpcResponse | null {
  const events: JsonRpcResponse[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    try {
      const parsed = JSON.parse(raw) as JsonRpcResponse | JsonRpcResponse[];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') events.push(item);
        }
      } else if (parsed && typeof parsed === 'object') {
        events.push(parsed);
      }
    } catch {
      // Ignore non-JSON SSE control frames or comments.
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  const exact = events.find(e => e.id === expectedId);
  if (exact) return exact;
  return events.findLast(e => 'result' in e || 'error' in e) ?? null;
}

function mergeSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`MCP request timed out after ${timeoutMs} ms.`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      external.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

let rpcSeq = 1;

async function postJsonRpc(
  url: string,
  secret: McpServerSecret | undefined,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  isNotification: boolean,
  options: McpClientOptions,
): Promise<{ status: number; sessionId?: string; message: JsonRpcResponse | null; rawError?: string }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const id = isNotification ? undefined : rpcSeq++;
  const payload = isNotification
    ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
    : { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...buildAuthHeaders(secret),
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };

  const { signal, cleanup } = mergeSignals(options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, options.signal);
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    const nextSessionId = response.headers.get('Mcp-Session-Id') ?? response.headers.get('mcp-session-id') ?? undefined;
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        status: response.status,
        sessionId: nextSessionId,
        message: null,
        rawError: errBody.trim() || `${response.status} ${response.statusText}`.trim(),
      };
    }
    if (isNotification || response.status === 202 || response.status === 204) {
      return { status: response.status, sessionId: nextSessionId, message: null };
    }
    const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
    const text = await response.text();
    if (!text.trim()) return { status: response.status, sessionId: nextSessionId, message: null };
    if (contentType.includes('text/event-stream')) {
      return {
        status: response.status,
        sessionId: nextSessionId,
        message: parseSseJsonRpc(text, id!),
      };
    }
    const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    const msg = Array.isArray(parsed) ? (parsed.find(m => m.id === id) ?? parsed[0] ?? null) : parsed;
    return { status: response.status, sessionId: nextSessionId, message: msg };
  } finally {
    cleanup();
  }
}

async function ensureSession(
  url: string,
  secret: McpServerSecret | undefined,
  options: McpClientOptions,
  forceReset = false,
): Promise<string | undefined> {
  if (!forceReset && sessionCache.has(url)) {
    return sessionCache.get(url)?.sessionId;
  }
  const init = await postJsonRpc(
    url,
    secret,
    undefined,
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nanobrowser', version: '0.3.0' },
    },
    false,
    options,
  );
  if (init.rawError || !init.message) {
    throw new Error(init.rawError || `MCP initialize failed (HTTP ${init.status}).`);
  }
  if (init.message.error) {
    throw new Error(init.message.error.message || 'MCP initialize error.');
  }
  sessionCache.set(url, { sessionId: init.sessionId });
  // Best-effort initialized notification; stateless servers may respond 202/204/404/405.
  await postJsonRpc(url, secret, init.sessionId, 'notifications/initialized', undefined, true, options).catch(
    () => undefined,
  );
  return init.sessionId;
}

async function callJsonRpc(
  url: string,
  secret: McpServerSecret | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  options: McpClientOptions,
): Promise<unknown> {
  let sessionId = await ensureSession(url, secret, options);
  let res = await postJsonRpc(url, secret, sessionId, method, params, false, options);

  // If a cached session expired server-side, re-initialize cleanly once and retry.
  if ((res.status === 400 || res.status === 404) && sessionId) {
    sessionCache.delete(url);
    sessionId = await ensureSession(url, secret, options, true);
    res = await postJsonRpc(url, secret, sessionId, method, params, false, options);
  }

  if (res.rawError) {
    throw new Error(`HTTP ${res.status}: ${res.rawError}`);
  }
  if (!res.message) {
    throw new Error(`Empty response from MCP server for ${method}.`);
  }
  if (res.message.error) {
    throw new Error(res.message.error.message || `MCP error (${res.message.error.code ?? 'unknown'})`);
  }
  return res.message.result;
}

/** Connects to a remote MCP server and retrieves its full list of tools. */
export async function fetchServerTools(
  rawUrl: string,
  secret?: McpServerSecret,
  options: McpClientOptions = {},
): Promise<McpToolInfo[]> {
  const url = normalizeMcpUrl(rawUrl);
  if (!url) throw new Error('Invalid MCP server URL. Use an http:// or https:// address.');

  const clientOpts: McpClientOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS,
  };
  sessionCache.delete(url);

  const tools: McpToolInfo[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const result = (await callJsonRpc(url, secret, 'tools/list', cursor ? { cursor } : undefined, clientOpts)) as {
      tools?: Array<{
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
        annotations?: { readOnlyHint?: unknown };
      }>;
      nextCursor?: unknown;
    };

    for (const t of result?.tools ?? []) {
      if (typeof t?.name !== 'string' || !t.name.trim()) continue;
      tools.push({
        name: t.name.trim(),
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: normalizeToolSchema(t.inputSchema),
        ...(t.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
      });
    }

    const next = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return tools;
}

/** Formats an MCP `tools/call` response into plain text suitable for the agent loop. */
export function formatMcpCallResult(result: unknown): { text: string; isError: boolean } {
  if (!result || typeof result !== 'object') {
    return { text: String(result ?? ''), isError: false };
  }
  const r = result as {
    content?: Array<Record<string, unknown>>;
    structuredContent?: unknown;
    isError?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
        const res = item.resource as { uri?: unknown; text?: unknown };
        const uri = typeof res.uri === 'string' ? res.uri : 'resource';
        const body = typeof res.text === 'string' ? res.text : '';
        parts.push(body ? `[${uri}]\n${body}` : `[${uri}]`);
      } else if (item.type === 'resource_link') {
        const uri = typeof item.uri === 'string' ? item.uri : '';
        const name = typeof item.name === 'string' ? item.name : '';
        parts.push(name ? `[link: ${name} (${uri})]` : `[link: ${uri}]`);
      } else if (item.type === 'image') {
        const mime = typeof item.mimeType === 'string' ? item.mimeType : 'image';
        parts.push(`[image (${mime}) returned by MCP tool]`);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
  }
  if (!parts.length && r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  }
  return {
    text: parts.join('\n\n') || '(empty tool result)',
    isError: r.isError === true,
  };
}

/** Executes a single MCP tool call against a remote server. */
export async function invokeMcpTool(
  binding: McpToolBinding,
  args: Record<string, unknown>,
  options: McpClientOptions = {},
): Promise<{ text: string; isError: boolean }> {
  try {
    const result = await callJsonRpc(
      binding.server.url,
      binding.secret,
      'tools/call',
      { name: binding.remoteName, arguments: args },
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
    );
    return formatMcpCallResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `error MCP_CALL_FAILED (${binding.server.name}/${binding.remoteName}): ${message}`, isError: true };
  }
}

export function clearMcpSessions(): void {
  sessionCache.clear();
}
