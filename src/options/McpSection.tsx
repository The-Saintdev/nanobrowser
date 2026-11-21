// Settings → MCP: add and manage remote Streamable HTTP MCP servers whose tools run alongside Nanobrowser's.
import { useState } from 'react';
import { Button, Field, Input, Notice, Select, Switch } from '@src/ui/components';
import { useStorage } from '@src/ui/hooks';
import { t } from '@src/ui/i18n';
import { MCP_REQUEST } from '@src/ui/protocol';
import {
  mcpSecretsStorage,
  mcpServersStorage,
  normalizeMcpUrl,
  parseMcpJsonImport,
  removeMcpServer,
  upsertMcpServer,
} from '@src/store/mcp';
import type { McpAuthType, McpServerConfig, McpServerSecret, McpToolInfo } from '@src/store/mcp';
import { SettingsCard, SettingsRow } from './SettingsCard';

const NO_SERVERS: McpServerConfig[] = [];
const NO_SECRETS: Record<string, McpServerSecret> = {};
const IMPORT_PLACEHOLDER = `{
  "mcp": {
    "servers": {
      "saintstack": {
        "type": "remote",
        "url": "https://saintstack.crescoafrica.com/mcp",
        "headers": {
          "Authorization": "Bearer saint_sec_..."
        }
      }
    }
  }
}`;

interface McpTestReply {
  ok: boolean;
  tools?: McpToolInfo[];
  error?: string;
}

async function testMcpEndpoint(url: string, secret: McpServerSecret): Promise<McpTestReply> {
  try {
    return (await chrome.runtime.sendMessage({ type: MCP_REQUEST, op: 'test', url, secret })) as McpTestReply;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function ServerCard({ server, secret }: { server: McpServerConfig; secret?: McpServerSecret }) {
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showTools, setShowTools] = useState(false);

  const [name, setName] = useState(server.name);
  const [url, setUrl] = useState(server.url);
  const [authType, setAuthType] = useState<McpAuthType>(secret?.authType ?? 'none');
  const [headerName, setHeaderName] = useState(secret?.headerName ?? '');
  const [token, setToken] = useState(secret?.token ?? '');
  const [showToken, setShowToken] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const sync = async () => {
    setSyncing(true);
    const res = await testMcpEndpoint(server.url, secret ?? { authType: 'none' });
    setSyncing(false);
    if (res.ok && res.tools) {
      await upsertMcpServer({
        ...server,
        tools: res.tools,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      });
    } else {
      await upsertMcpServer({
        ...server,
        lastError: res.error || t('mcp.connectError'),
      });
    }
  };

  const saveEdit = async () => {
    const normalized = normalizeMcpUrl(url);
    if (!normalized) {
      setEditError(t('mcp.invalidUrl'));
      return;
    }
    if (authType === 'custom' && !headerName.trim()) {
      setEditError(t('mcp.missingHeader'));
      return;
    }
    setEditError(null);
    const nextSecret: McpServerSecret = {
      authType,
      ...(authType !== 'none' && token.trim() ? { token: token.trim() } : {}),
      ...(authType === 'custom' && headerName.trim() ? { headerName: headerName.trim() } : {}),
    };
    setSyncing(true);
    const res = await testMcpEndpoint(normalized, nextSecret);
    setSyncing(false);
    await upsertMcpServer(
      {
        ...server,
        name: name.trim() || new URL(normalized).host,
        url: normalized,
        tools: res.ok && res.tools ? res.tools : server.tools,
        ...(res.ok ? { lastSyncedAt: new Date().toISOString(), lastError: undefined } : { lastError: res.error }),
      },
      nextSecret,
    );
    setEditing(false);
  };

  const toolSummary = server.tools.length
    ? t(server.tools.length === 1 ? 'mcp.toolCountOne' : 'mcp.toolCount', { count: server.tools.length })
    : t('mcp.noToolsSynced');

  return (
    <SettingsCard className="flex flex-col gap-4">
      <SettingsRow
        label={server.name}
        description={
          <span className="flex flex-col gap-0.5">
            <span className="break-all font-mono text-xs">{server.url}</span>
            <span>{toolSummary}</span>
          </span>
        }>
        <Switch
          checked={server.enabled}
          aria-label={t('mcp.toggleServer', { name: server.name })}
          onChange={enabled => void upsertMcpServer({ ...server, enabled })}
        />
      </SettingsRow>

      <SettingsRow label={t('mcp.autoApprove')} description={t('mcp.autoApproveHint')}>
        <Switch
          checked={server.autoApprove === true}
          aria-label={t('mcp.autoApproveToggle', { name: server.name })}
          onChange={autoApprove => void upsertMcpServer({ ...server, autoApprove })}
        />
      </SettingsRow>

      {server.lastError ? <Notice tone="error">{server.lastError}</Notice> : null}

      {editing ? (
        <div className="flex flex-col gap-3 rounded-xl border border-nb-border bg-nb-surface/40 p-4">
          {editError ? <Notice tone="error">{editError}</Notice> : null}
          <Field label={t('mcp.name')}>
            <Input value={name} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label={t('mcp.url')}>
            <Input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </Field>
          <Field label={t('mcp.authType')}>
            <Select value={authType} onChange={e => setAuthType(e.target.value as McpAuthType)}>
              <option value="none">{t('mcp.authNone')}</option>
              <option value="bearer">{t('mcp.authBearer')}</option>
              <option value="x-api-key">{t('mcp.authApiKey')}</option>
              <option value="custom">{t('mcp.authCustom')}</option>
            </Select>
          </Field>
          {authType === 'custom' ? (
            <Field label={t('mcp.headerName')}>
              <Input value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="X-MCP-Token" />
            </Field>
          ) : null}
          {authType !== 'none' ? (
            <Field label={t('mcp.token')}>
              <div className="flex gap-2">
                <Input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  className="flex-1"
                />
                <Button onClick={() => setShowToken(v => !v)}>
                  {showToken ? t('models.hideKey') : t('models.showKey')}
                </Button>
              </div>
            </Field>
          ) : null}
          <div className="flex gap-2">
            <Button variant="primary" disabled={syncing} onClick={() => void saveEdit()}>
              {syncing ? t('mcp.testing') : t('common.save')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setEditError(null);
              }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={syncing} onClick={() => void sync()}>
          {syncing ? t('mcp.testing') : t('mcp.syncTools')}
        </Button>
        {server.tools.length > 0 ? (
          <Button variant="ghost" onClick={() => setShowTools(v => !v)}>
            {showTools ? t('mcp.hideTools') : t('mcp.showTools')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setEditing(v => !v)}>
          {t('mcp.edit')}
        </Button>
        {confirmRemove ? (
          <>
            <Button variant="danger" onClick={() => void removeMcpServer(server.id)}>
              {t('common.remove')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setConfirmRemove(true)}>
            {t('common.remove')}
          </Button>
        )}
      </div>

      {showTools && server.tools.length > 0 ? (
        <ul className="flex flex-col gap-1.5 rounded-xl border border-nb-border bg-nb-surface/40 p-3">
          {server.tools.map(tool => (
            <li key={tool.name} className="flex flex-col gap-0.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium">{tool.name}</span>
                {tool.readOnly ? (
                  <span className="rounded bg-nb-surface px-1.5 py-0.5 text-[11px] text-nb-muted">
                    {t('mcp.readOnlyBadge')}
                  </span>
                ) : null}
              </div>
              {tool.description ? <p className="text-xs text-nb-muted">{tool.description}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsCard>
  );
}

export function McpSection() {
  const servers = useStorage(mcpServersStorage, NO_SERVERS);
  const secrets = useStorage(mcpSecretsStorage, NO_SECRETS);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<McpAuthType>('bearer');
  const [headerName, setHeaderName] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSaveOffline, setCanSaveOffline] = useState(false);

  const [jsonText, setJsonText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const buildDraft = (): { url: string; name: string; secret: McpServerSecret } | null => {
    const normalized = normalizeMcpUrl(url);
    if (!normalized) {
      setError(t('mcp.invalidUrl'));
      return null;
    }
    if (authType === 'custom' && !headerName.trim()) {
      setError(t('mcp.missingHeader'));
      return null;
    }
    const secret: McpServerSecret = {
      authType,
      ...(authType !== 'none' && token.trim() ? { token: token.trim() } : {}),
      ...(authType === 'custom' && headerName.trim() ? { headerName: headerName.trim() } : {}),
    };
    return {
      url: normalized,
      name: name.trim() || new URL(normalized).host,
      secret,
    };
  };

  const resetForm = () => {
    setName('');
    setUrl('');
    setToken('');
    setHeaderName('');
    setError(null);
    setCanSaveOffline(false);
  };

  const saveServer = async (
    draft: { url: string; name: string; secret: McpServerSecret },
    tools: McpToolInfo[],
    syncError?: string,
  ) => {
    const id = crypto.randomUUID();
    await upsertMcpServer(
      {
        id,
        name: draft.name,
        url: draft.url,
        enabled: true,
        tools,
        ...(!syncError ? { lastSyncedAt: new Date().toISOString() } : { lastError: syncError }),
      },
      draft.secret,
    );
    resetForm();
  };

  const handleAdd = async () => {
    const draft = buildDraft();
    if (!draft) return;
    setError(null);
    setCanSaveOffline(false);
    setBusy(true);
    const res = await testMcpEndpoint(draft.url, draft.secret);
    setBusy(false);
    if (res.ok && res.tools) {
      await saveServer(draft, res.tools);
      return;
    }
    setError(res.error || t('mcp.connectError'));
    setCanSaveOffline(true);
  };

  const handleSaveOffline = async () => {
    const draft = buildDraft();
    if (!draft) return;
    await saveServer(draft, [], error ?? t('mcp.connectError'));
  };

  const handleImportJson = async () => {
    setImportError(null);
    setImportNotice(null);
    const parsed = parseMcpJsonImport(jsonText);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    if (!parsed.servers.length) {
      const skipped = parsed.skippedLocal.length
        ? t('mcp.importSkippedLocal', { names: parsed.skippedLocal.join(', ') })
        : '';
      setImportError([t('mcp.importEmpty'), skipped].filter(Boolean).join(' '));
      return;
    }
    setImporting(true);
    for (const entry of parsed.servers) {
      const existing = servers.find(s => s.url === entry.url);
      const res = await testMcpEndpoint(entry.url, entry.secret);
      await upsertMcpServer(
        {
          id: existing?.id ?? crypto.randomUUID(),
          name: entry.name,
          url: entry.url,
          enabled: entry.enabled,
          ...(entry.autoApprove !== undefined
            ? { autoApprove: entry.autoApprove }
            : existing?.autoApprove
              ? { autoApprove: existing.autoApprove }
              : {}),
          tools: res.ok && res.tools ? res.tools : (existing?.tools ?? []),
          ...(res.ok ? { lastSyncedAt: new Date().toISOString(), lastError: undefined } : { lastError: res.error }),
        },
        entry.secret,
      );
    }
    setImporting(false);
    setJsonText('');
    const count = parsed.servers.length;
    const summary = t(count === 1 ? 'mcp.importDoneOne' : 'mcp.importDone', { count });
    const skipped = parsed.skippedLocal.length
      ? ` ${t('mcp.importSkippedLocal', { names: parsed.skippedLocal.join(', ') })}`
      : '';
    setImportNotice(`${summary}${skipped}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.mcp')}</h2>
      <Notice>{t('mcp.privacyNote')}</Notice>

      <SettingsCard title={t('mcp.importTitle')} description={t('mcp.importHint')} className="flex flex-col gap-3">
        {importError ? <Notice tone="error">{importError}</Notice> : null}
        {importNotice ? <Notice tone="ok">{importNotice}</Notice> : null}
        <textarea
          aria-label={t('mcp.importTitle')}
          value={jsonText}
          onChange={e => setJsonText(e.target.value)}
          rows={6}
          placeholder={IMPORT_PLACEHOLDER}
          className="rounded-lg border border-nb-border bg-nb-bg px-3 py-2 font-mono text-xs leading-relaxed focus:border-nb-accent focus:outline-none focus:ring-2 focus:ring-nb-accent/25"
        />
        <div>
          <Button variant="primary" disabled={importing || !jsonText.trim()} onClick={() => void handleImportJson()}>
            {importing ? t('mcp.importing') : t('mcp.importButton')}
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard title={t('mcp.addTitle')} description={t('mcp.addHint')} className="flex flex-col gap-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field label={t('mcp.name')}>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="SaintStack" />
        </Field>
        <Field label={t('mcp.url')} hint={t('mcp.urlHint')}>
          <Input
            type="url"
            value={url}
            onChange={e => {
              setUrl(e.target.value);
              setCanSaveOffline(false);
            }}
            placeholder="https://saintstack.crescoafrica.com/mcp"
          />
        </Field>
        <Field label={t('mcp.authType')}>
          <Select value={authType} onChange={e => setAuthType(e.target.value as McpAuthType)}>
            <option value="none">{t('mcp.authNone')}</option>
            <option value="bearer">{t('mcp.authBearer')}</option>
            <option value="x-api-key">{t('mcp.authApiKey')}</option>
            <option value="custom">{t('mcp.authCustom')}</option>
          </Select>
        </Field>
        {authType === 'custom' ? (
          <Field label={t('mcp.headerName')}>
            <Input value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="X-MCP-Token" />
          </Field>
        ) : null}
        {authType !== 'none' ? (
          <Field label={t('mcp.token')}>
            <div className="flex gap-2">
              <Input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder={t('mcp.tokenPlaceholder')}
                className="flex-1"
              />
              <Button onClick={() => setShowToken(v => !v)}>
                {showToken ? t('models.hideKey') : t('models.showKey')}
              </Button>
            </div>
          </Field>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !url.trim()} onClick={() => void handleAdd()}>
            {busy ? t('mcp.testing') : t('mcp.testAndAdd')}
          </Button>
          {canSaveOffline ? <Button onClick={() => void handleSaveOffline()}>{t('mcp.saveAnyway')}</Button> : null}
        </div>
      </SettingsCard>

      {servers.map(server => (
        <ServerCard key={server.id} server={server} secret={secrets[server.id]} />
      ))}
    </div>
  );
}
