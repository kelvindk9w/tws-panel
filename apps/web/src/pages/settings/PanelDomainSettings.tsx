import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CertificateItem, PanelDomainDnsCheck, PanelDomainStatus, PanelDomainVerifyResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, lowerCase, Trans, useI18n, type Key } from "@/i18n";
import { pageLocation } from "@/lib/page-location";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/mail/CopyButton";
import { CertificateCard } from "@/pages/CertificatesPage";
import { certificatePending, useAutoRefresh } from "@/lib/auto-refresh";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldOff,
  Terminal,
  Trash2,
} from "lucide-react";

/** Só erro da API traz mensagem própria; qualquer outro vira o texto padrão. */
function errorText(err: unknown, fallback: Key): string {
  return apiErrorText(err instanceof ApiRequestError ? err : null, fallback);
}

const PATH = "/api/settings/panel-domain";
const SWITCH_TO_HTTPS = "cd /opt/tws-panel && sudo ./scripts/install.sh --acesso=https";

function certificateValid(item: CertificateItem | null): boolean {
  return item !== null && (item.state === "valid" || item.state === "expiring");
}

/** Comando de terminal com botão de copiar (quebra a linha no celular). */
function Command({ text, testId }: { text: string; testId?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-1 rounded-md border bg-muted/40 px-3 py-2" data-testid={testId}>
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{text}</code>
      <CopyButton text={text} ariaLabel={t("panelDomain.command.copyAria")} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 break-all font-mono text-sm">{value}</code>
        <CopyButton text={value} ariaLabel={t("panelDomain.field.copyAria", { label: lowerCase(label) })} />
      </span>
    </div>
  );
}

function DnsResult({ check }: { check: PanelDomainDnsCheck }) {
  return (
    <p
      data-testid="dns-result"
      className={
        check.ok
          ? "flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400"
          : "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400"
      }
    >
      {check.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{check.message}</span>
    </p>
  );
}

function Section({ title, icon, description, children }: { title: string; icon: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon} {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">{children}</CardContent>
    </Card>
  );
}

/**
 * Configurações → Domínio do painel. O painel nasce em
 * https://<ip-com-hífens>.sslip.io (o endereço tem o IP da VPS no nome).
 * Aqui a pessoa usa um domínio seu: registro A → Verificar DNS → o painel
 * responde nos dois endereços e emite o certificado → abrir pelo endereço
 * novo e entrar de novo → (opcional) desativar o acesso pelo IP, com volta
 * pela tela ou por SSH.
 */
export function PanelDomainSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PanelDomainStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "verify" | "remove" | "disable" | "enable" | "refresh" | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [lastCheck, setLastCheck] = useState<PanelDomainDnsCheck | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [typed, setTyped] = useState("");

  /** `quiet`: consulta automática — uma falha mantém a tela como está (a próxima tenta de novo). */
  const load = useCallback(async (quiet = false) => {
    try {
      const s = await apiFetch<PanelDomainStatus>(PATH);
      setStatus(s);
      setLastCheck(s.lastCheck);
      setLoadError(null);
    } catch {
      if (!quiet) setLoadError(t("panelDomain.load.error"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Domínio no proxy e certificado ainda não válido (emitindo, falhou, não
  // conferido): a tela consulta sozinha e, quando ele fica válido, atualiza
  // o certificado, o link para o endereço novo e o "Desativar o acesso pelo IP".
  const watching =
    status !== null &&
    status.mode !== "tunnel" &&
    status.domain !== null &&
    status.domainActive &&
    (status.certificate === null || certificatePending(status.certificate));
  useAutoRefresh(watching, () => load(true));

  async function act(kind: NonNullable<typeof busy>, fn: () => Promise<void>, fallback: Key) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void act(
      "save",
      async () => {
        const s = await apiFetch<PanelDomainStatus>(PATH, { method: "PUT", body: JSON.stringify({ domain: input.trim() }) });
        setStatus(s);
        setLastCheck(s.lastCheck);
        setEditing(false);
      },
      "panelDomain.error.save",
    );
  }

  const verify = () =>
    act(
      "verify",
      async () => {
        const r = await apiFetch<PanelDomainVerifyResponse>(`${PATH}/verify`, { method: "POST" });
        setStatus(r.status);
        setLastCheck(r.check);
      },
      "panelDomain.error.verify",
    );

  const remove = () =>
    act(
      "remove",
      async () => {
        const s = await apiFetch<PanelDomainStatus>(PATH, { method: "DELETE" });
        setStatus(s);
        setLastCheck(null);
        setConfirmRemove(false);
        setInput("");
      },
      "panelDomain.error.remove",
    );

  const disableIp = () =>
    act(
      "disable",
      async () => {
        const s = await apiFetch<PanelDomainStatus>(`${PATH}/disable-ip`, {
          method: "POST",
          body: JSON.stringify({ confirm: typed.trim() }),
        });
        setStatus(s);
        setConfirmDisable(false);
        setTyped("");
      },
      "panelDomain.error.disableIp",
    );

  const enableIp = () =>
    act(
      "enable",
      async () => setStatus(await apiFetch<PanelDomainStatus>(`${PATH}/enable-ip`, { method: "POST" })),
      "panelDomain.error.enableIp",
    );

  const refresh = () => act("refresh", () => load(), "panelDomain.error.refresh");

  if (loadError) {
    return (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {loadError}
      </p>
    );
  }
  if (!status) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const errorBox = error && (
    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  );

  if (status.mode === "tunnel") {
    return (
      <Section title={t("panelDomain.tunnel.title")} icon={<Globe className="h-4 w-4" />}>
        <div data-testid="tunnel-mode" className="flex flex-col gap-3">
          <p>
            <Trans k="panelDomain.tunnel.intro" components={{ b: <strong /> }} />
          </p>
          <p>{t("panelDomain.tunnel.switch")}</p>
          <Command text={SWITCH_TO_HTTPS} />
          <p className="text-xs text-muted-foreground">
            {t("panelDomain.tunnel.note", { host: `<${t("panelDomain.tunnel.hostPlaceholder")}>` })}
          </p>
        </div>
      </Section>
    );
  }

  const domain = status.domain;
  const valid = certificateValid(status.certificate);
  // O navegador comprova que o endereço novo funciona: além do servidor, a
  // própria página precisa estar aberta nele.
  const browserOnDomain = domain !== null && pageLocation().hostname.toLowerCase() === domain;
  const canDisable = status.disableIp.allowed && browserOnDomain;
  const showForm = !domain || editing;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t("panelDomain.addresses.title")}
        icon={<Globe className="h-4 w-4" />}
        description={t("panelDomain.addresses.description")}
      >
        <ul data-testid="panel-addresses" className="flex flex-col gap-2">
          {status.addresses.map((a) => (
            <li key={a} className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-sm">https://{a}</span>
              {a === status.ipAddress ? <Badge variant="warning">{t("panelDomain.addresses.badgeIp")}</Badge> : <Badge variant="success">{t("panelDomain.addresses.badgeDomain")}</Badge>}
              {a === status.currentHost && <Badge variant="outline">{t("panelDomain.addresses.badgeCurrent")}</Badge>}
            </li>
          ))}
        </ul>
        {status.ipAccessDisabled && status.ipAddress && (
          <p className="text-xs text-muted-foreground">
            {t("panelDomain.addresses.ipDisabled", { ip: status.ipAddress })}
          </p>
        )}
      </Section>

      <Section
        title={t("panelDomain.domain.title")}
        icon={<Lock className="h-4 w-4" />}
        description={t("panelDomain.domain.description")}
      >
        {showForm ? (
          <form onSubmit={save} className="flex max-w-lg flex-col gap-3">
            <label htmlFor="panel-domain" className="font-medium">
              {t("panelDomain.domain.label")}
            </label>
            <Input
              id="panel-domain"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("panelDomain.domain.placeholder")}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
            {editing && status.ipAccessDisabled && (
              <p className="text-xs text-amber-400">
                {t("panelDomain.domain.changeWarning", { ip: status.ipAddress ?? "" })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy !== null || input.trim() === ""}>
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("panelDomain.domain.save")}
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  {t("panelDomain.domain.cancel")}
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono">{domain}</span>
              {status.domainActive ? (
                <Badge variant="success">{t("panelDomain.domain.badgeActive")}</Badge>
              ) : (
                <Badge variant="warning">{t("panelDomain.domain.badgePending")}</Badge>
              )}
            </div>

            {!status.domainActive && (
              <>
                <p>{t("panelDomain.domain.createRecord")}</p>
                <div data-testid="dns-record" className="grid grid-cols-1 gap-3 rounded-md border px-3 py-3 sm:grid-cols-3">
                  <Field label={t("panelDomain.domain.recordType")} value="A" />
                  <Field label={t("panelDomain.domain.recordName")} value={domain!} />
                  <Field label={t("panelDomain.domain.recordValue")} value={status.serverIp ?? t("panelDomain.domain.recordValueFallback")} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("panelDomain.domain.cloudflareNote")}
                </p>
              </>
            )}

            {lastCheck && <DnsResult check={lastCheck} />}

            <div className="flex flex-wrap gap-2">
              {!status.domainActive && (
                <Button variant="info" disabled={busy !== null} onClick={() => void verify()}>
                  {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {t("panelDomain.domain.verify")}
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setInput(domain ?? "");
                  setEditing(true);
                  setConfirmRemove(false);
                }}
              >
                {t("panelDomain.domain.change")}
              </Button>
              {!confirmRemove && (
                <Button variant="danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                  <Trash2 className="h-4 w-4" /> {t("panelDomain.domain.remove")}
                </Button>
              )}
            </div>

            {confirmRemove && (
              <div data-testid="remove-confirm" className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3">
                <p>
                  {t("panelDomain.domain.removeConfirm", {
                    domain: domain ?? "",
                    ip: status.ipAddress ?? "",
                    extra: status.ipAccessDisabled ? t("panelDomain.domain.removeConfirmReactivated") : "",
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setConfirmRemove(false)} disabled={busy !== null}>
                    {t("panelDomain.domain.removeCancel")}
                  </Button>
                  <Button variant="danger" onClick={() => void remove()} disabled={busy !== null}>
                    {busy === "remove" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("panelDomain.domain.removeYes")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {errorBox}
      </Section>

      {domain && status.domainActive && (
        <Section
          title={t("panelDomain.certificate.title")}
          icon={<Lock className="h-4 w-4" />}
          description={t("panelDomain.certificate.description")}
        >
          {status.certificate ? (
            <ul>
              <CertificateCard
                item={status.certificate}
                onItem={(item) => setStatus((s) => (s ? { ...s, certificate: item } : s))}
                onValid={() => load(true)}
                pollMs={10_000}
                pollMaxMs={120_000}
              />
            </ul>
          ) : (
            <p className="text-muted-foreground">{t("panelDomain.certificate.unknown")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void refresh()}>
              {busy === "refresh" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("panelDomain.certificate.refresh")}
            </Button>
          </div>
          {valid && !browserOnDomain && (
            <div className="flex flex-col gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-3">
              <Button variant="info" asChild className="h-auto min-h-9 self-start whitespace-normal py-2 text-left">
                <a href={`https://${domain}/settings/panel-domain`}>
                  <ExternalLink className="h-4 w-4" /> {t("panelDomain.certificate.openNew")}
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                {t("panelDomain.certificate.openNewNote")}
              </p>
            </div>
          )}
        </Section>
      )}

      <Section
        title={t("panelDomain.ip.title")}
        icon={<ShieldOff className="h-4 w-4" />}
        description={t("panelDomain.ip.description", { ip: String(status.ipAddress) })}
      >
        {status.ipAccessDisabled ? (
          <div className="flex flex-col gap-3">
            <p>{t("panelDomain.ip.disabledInfo", { domain: domain ?? "" })}</p>
            <Button variant="success" className="self-start" disabled={busy !== null} onClick={() => void enableIp()}>
              {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {t("panelDomain.ip.enable")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {!confirmDisable && (
              <Button
                variant="danger"
                className="self-start"
                disabled={busy !== null || !canDisable}
                onClick={() => setConfirmDisable(true)}
              >
                <ShieldOff className="h-4 w-4" /> {t("panelDomain.ip.disable")}
              </Button>
            )}
            {!canDisable && (
              <ul data-testid="disable-ip-blockers" className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                {(status.disableIp.blockers.length
                  ? status.disableIp.blockers
                  : [t("panelDomain.ip.blockerDefault", { domain: domain ?? t("panelDomain.ip.blockerDefaultDomain") })]
                ).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {confirmDisable && (
              <div data-testid="disable-ip-confirm" className="flex flex-col gap-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3">
                <p>
                  <Trans
                    k="panelDomain.ip.disableConfirm"
                    params={{ domain: domain ?? "", ip: status.ipAddress ?? "" }}
                    components={{ b: <strong /> }}
                  />
                </p>
                <Command text={status.reactivateCommand} testId="reactivate-command" />
                <label htmlFor="disable-confirm" className="font-medium">
                  {t("panelDomain.ip.typeToConfirm", { domain: domain ?? "" })}
                </label>
                <Input
                  id="disable-confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setConfirmDisable(false)} disabled={busy !== null}>
                    {t("panelDomain.ip.cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy !== null || typed.trim().toLowerCase() !== domain}
                    onClick={() => void disableIp()}
                  >
                    {busy === "disable" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("panelDomain.ip.disableNow")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {!confirmDisable && (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 font-medium">
              <Terminal className="h-4 w-4" /> {t("panelDomain.ip.lostAccess")}
            </p>
            <p className="text-xs text-muted-foreground">{t("panelDomain.ip.lostAccessHelp")}</p>
            <Command text={status.reactivateCommand} testId="reactivate-command" />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t("panelDomain.ip.configNote", { file: status.configFile })}
        </p>
      </Section>
    </div>
  );
}
