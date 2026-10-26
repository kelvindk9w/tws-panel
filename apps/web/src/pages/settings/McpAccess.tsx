import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { McpApprovalInfo, McpApprovalListResponse, McpSettingsResponse, UpdateMcpSettingsRequest } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, useI18n, type Key } from "@/i18n";
import { mcpGuideUrl } from "@/lib/links";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { BookOpen, Check, Loader2, Plug, RefreshCw, TriangleAlert, X } from "lucide-react";

/** Segundos entre as consultas de pedidos enquanto o MCP está ligado. */
const POLL_MS = 5000;

const TOOL_KEY: Record<string, Key> = {
  recreate_project: "settings.mcp.approvals.tool.recreate_project",
  security_apply: "settings.mcp.approvals.tool.security_apply",
  update_project: "settings.mcp.approvals.tool.update_project",
  set_env_vars: "settings.mcp.approvals.tool.set_env_vars",
};
/** Rótulos dos campos que o servidor manda para a pessoa conferir (nome desconhecido aparece como veio). */
const ARG_KEY: Record<string, Key> = {
  project: "settings.mcp.approvals.arg.project",
  variables: "settings.mcp.approvals.arg.variables",
  values: "settings.mcp.approvals.arg.values",
  name: "settings.mcp.approvals.arg.name",
  domain: "settings.mcp.approvals.arg.domain",
  branch: "settings.mcp.approvals.arg.branch",
  pair: "settings.mcp.approvals.arg.pair",
  websocket: "settings.mcp.approvals.arg.websocket",
  proxyService: "settings.mcp.approvals.arg.proxyService",
  proxyPort: "settings.mcp.approvals.arg.proxyPort",
  phase: "settings.mcp.approvals.arg.phase",
  dryRun: "settings.mcp.approvals.arg.dryRun",
  sshUser: "settings.mcp.approvals.arg.sshUser",
  sshPublicKey: "settings.mcp.approvals.arg.sshPublicKey",
};
const STATUS_KEY: Record<McpApprovalInfo["status"], Key> = {
  pending: "settings.mcp.approvals.status.pending",
  approved: "settings.mcp.approvals.status.approved",
  rejected: "settings.mcp.approvals.status.rejected",
  expired: "settings.mcp.approvals.status.expired",
  used: "settings.mcp.approvals.status.used",
};

/** Um pedido pendente: a pessoa lê, e aprova (com a senha) ou recusa. */
function PendingApproval({ approval, twoFactor, onDone }: { approval: McpApprovalInfo; twoFactor: boolean | null; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { password: useId(), code: useId() };
  const toolKey = TOOL_KEY[approval.tool];
  const ready = password.length > 0 && (twoFactor !== true || code.trim().length > 0) && !busy;

  async function approve(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/mcp/approvals/${approval.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, ...(twoFactor !== false && code.trim() ? { code: code.trim() } : {}) }),
      });
      await onDone();
    } catch (err) {
      setError(apiErrorText(err, "settings.mcp.approvals.error.approve"));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/mcp/approvals/${approval.id}/reject`, { method: "POST", body: JSON.stringify({}) });
      await onDone();
    } catch (err) {
      setError(apiErrorText(err, "settings.mcp.approvals.error.reject"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li data-testid="mcp-approval-pending" className="flex min-w-0 flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="break-words font-medium">
        <strong data-testid="mcp-approval-token">{approval.tokenName}</strong> {t("settings.mcp.approvals.item.asks", { action: toolKey ? t(toolKey) : approval.tool })}
      </p>
      <p className="break-words text-xs text-muted-foreground" data-testid="mcp-approval-client">
        {t("settings.mcp.approvals.item.client", { client: approval.client })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {Object.entries(approval.args).map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{ARG_KEY[key] ? t(ARG_KEY[key]!) : key}</dt>
            <dd className="min-w-0 break-all font-mono">{String(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("settings.mcp.approvals.expires", { date: formatDateTime(approval.expiresAt) })}</p>
      {asking ? (
        <form onSubmit={(e) => void approve(e)} className="flex flex-col gap-1.5 text-sm">
          <label htmlFor={ids.password} className="font-medium">
            {t("settings.apiAccess.form.password.label")}
          </label>
          <PasswordInput id={ids.password} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {twoFactor !== false && (
            <>
              <label htmlFor={ids.code} className="font-medium">
                {t("settings.apiAccess.form.code.label")}
              </label>
              <Input id={ids.code} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="submit" size="sm" disabled={!ready}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {t("settings.mcp.approvals.approve.confirm")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setAsking(false)}>
              {t("settings.apiAccess.item.revokeCancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAsking(true)} disabled={busy}>
            <Check className="h-3.5 w-3.5" /> {t("settings.mcp.approvals.approve")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void reject()} disabled={busy}>
            <X className="h-3.5 w-3.5" /> {t("settings.mcp.approvals.reject")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Configurações → Acesso por IA, parte do MCP: liga/desliga (desligado por padrão), o endereço para conectar
 * um cliente e os pedidos de aprovação das ações sensíveis que uma IA fez.
 */
export function McpAccess({ twoFactor }: { twoFactor: boolean | null }) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<McpSettingsResponse | null>(null);
  const [approvals, setApprovals] = useState<McpApprovalInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = { password: useId(), code: useId() };
  const enabled = settings?.enabled === true;

  const loadApprovals = useCallback(async () => {
    try {
      const res = await apiFetch<McpApprovalListResponse>("/api/mcp/approvals");
      setApprovals(res.approvals);
      setApprovalsError(null);
    } catch (err) {
      setApprovalsError(apiErrorText(err, "settings.mcp.approvals.error.load"));
    }
  }, []);

  useEffect(() => {
    apiFetch<McpSettingsResponse>("/api/settings/mcp")
      .then(setSettings)
      .catch((err) => setError(apiErrorText(err, "settings.mcp.error.load")));
  }, []);

  // Com o MCP ligado, os pedidos novos aparecem sozinhos (a IA espera a decisão).
  useEffect(() => {
    if (!enabled) return;
    void loadApprovals();
    const timer = setInterval(() => void loadApprovals(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, loadApprovals]);

  async function change(next: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: UpdateMcpSettingsRequest = {
        enabled: next,
        ...(next ? { currentPassword: password, ...(twoFactor !== false && code.trim() ? { code: code.trim() } : {}) } : {}),
      };
      setSettings(await apiFetch<McpSettingsResponse>("/api/settings/mcp", { method: "PUT", body: JSON.stringify(body) }));
      setPassword("");
      setCode("");
    } catch (err) {
      setError(apiErrorText(err, "settings.mcp.error.save"));
    } finally {
      setBusy(false);
    }
  }

  const url = settings ? `${window.location.origin}${settings.path}` : "";
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");
  const canEnable = password.length > 0 && (twoFactor !== true || code.trim().length > 0) && !busy;

  return (
    <Card data-testid="mcp-access">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Plug className="h-4 w-4" /> {t("settings.mcp.title")}
          {settings && <Badge variant={enabled ? "success" : "outline"}>{enabled ? t("settings.mcp.status.on") : t("settings.mcp.status.off")}</Badge>}
        </CardTitle>
        <CardDescription>{t("settings.mcp.description")}</CardDescription>
        <a
          href={mcpGuideUrl(locale)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
        >
          <BookOpen className="h-3.5 w-3.5" /> {t("settings.mcp.guide")}
        </a>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
        {settings && !enabled && (
          <form onSubmit={(e) => void change(true, e)} className="flex max-w-lg flex-col gap-2" data-testid="mcp-enable-form">
            <p role="note" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t("settings.mcp.enable.warn")}</span>
            </p>
            <label htmlFor={ids.password} className="font-medium">
              {t("settings.mcp.enable.password")}
            </label>
            <PasswordInput id={ids.password} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {twoFactor !== false && (
              <>
                <label htmlFor={ids.code} className="font-medium">
                  {t("settings.mcp.enable.code")}
                </label>
                <Input id={ids.code} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              </>
            )}
            <Button type="submit" className="self-start" disabled={!canEnable}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.mcp.enable.button")}
            </Button>
          </form>
        )}
        {settings && enabled && (
          <>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="mcp-endpoint" className="font-medium">
                {t("settings.mcp.endpoint.label")}
              </label>
              <div className="flex min-w-0 items-center gap-1">
                <Input id="mcp-endpoint" readOnly value={url} className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={url} />
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.mcp.connect.body")}</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-xs" data-testid="mcp-connect-example">
                {`claude mcp add --transport http tws-panel ${url} \\\n  --header "Authorization: Bearer <${t("settings.mcp.connect.tokenPlaceholder")}>"`}
              </pre>
            </div>
            <Button variant="outline" className="self-start" disabled={busy} onClick={() => void change(false)}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.mcp.disable.button")}
            </Button>

            <section aria-labelledby="mcp-approvals-title" className="flex flex-col gap-2 border-t border-border pt-4" data-testid="mcp-approvals">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="mcp-approvals-title" className="font-semibold">
                  {t("settings.mcp.approvals.title")}
                </h3>
                {pending.length > 0 && <Badge variant="warning">{t("settings.mcp.approvals.waiting", { count: pending.length })}</Badge>}
                <Button variant="ghost" size="sm" onClick={() => void loadApprovals()} aria-label={t("settings.mcp.approvals.refresh")}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.mcp.approvals.intro")}</p>
              {approvalsError && (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  {approvalsError}
                </p>
              )}
              {approvals.length === 0 && !approvalsError && <p className="text-muted-foreground">{t("settings.mcp.approvals.empty")}</p>}
              {pending.length > 0 && (
                <ul className="flex flex-col gap-2" aria-live="polite">
                  {pending.map((a) => (
                    <PendingApproval key={a.id} approval={a} twoFactor={twoFactor} onDone={loadApprovals} />
                  ))}
                </ul>
              )}
              {decided.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="mcp-approvals-decided">
                  {decided.map((a) => (
                    <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant={a.status === "rejected" || a.status === "expired" ? "outline" : "success"}>{t(STATUS_KEY[a.status])}</Badge>
                      <span className="min-w-0 break-words">
                        {a.client} · {a.tokenName} · {TOOL_KEY[a.tool] ? t(TOOL_KEY[a.tool]!) : a.tool}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
