import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AppsDomainDnsCheck, AppsDomainRecord, AppsDomainStatus, AppsDomainVerifyResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, lowerCase, useI18n, type Key } from "@/i18n";
import { appsDomainGuideUrl } from "@/lib/links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/mail/CopyButton";
import { AlertTriangle, BookOpen, CheckCircle2, Globe, Loader2, RefreshCw, Trash2 } from "lucide-react";

const PATH = "/api/settings/apps-domain";

/** Só erro da API traz mensagem própria; qualquer outro vira o texto padrão. */
function errorText(err: unknown, fallback: Key): string {
  return apiErrorText(err instanceof ApiRequestError ? err : null, fallback);
}

/** Pré-visualização da base digitada (o servidor normaliza de verdade ao verificar). */
function previewBase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
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

/** Os registros a criar: tipo, nome (curinga) e valor, cada um com botão de copiar. */
function RecordTable({ records }: { records: AppsDomainRecord[] }) {
  const { t } = useI18n();
  return (
    <div data-testid="apps-dns-record" className="flex flex-col gap-2">
      <p>{t("panelDomain.apps.record.intro")}</p>
      {records.map((r) => (
        <div key={r.type} className="grid grid-cols-1 gap-3 rounded-md border px-3 py-3 sm:grid-cols-3">
          <Field label={t("panelDomain.apps.record.type")} value={r.type} />
          <Field label={t("panelDomain.apps.record.name")} value={r.name} />
          <Field label={t("panelDomain.apps.record.value")} value={r.value} />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t("panelDomain.apps.record.nameHint")}</p>
      <p className="text-xs text-muted-foreground">{t("panelDomain.apps.record.cloudflare")}</p>
    </div>
  );
}

/** Resultado da conferência: verde quando salvou, âmbar quando não (aviso, não erro); ícone + texto. */
function Result({ check, saved }: { check: AppsDomainDnsCheck; saved: boolean }) {
  const { t } = useI18n();
  return (
    <p
      role="status"
      data-testid="apps-dns-result"
      className={
        saved
          ? "flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400"
          : "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400"
      }
    >
      {saved ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>
        {!saved && <strong>{t("panelDomain.apps.result.notSaved")} </strong>}
        {check.message}
      </span>
    </p>
  );
}

/**
 * Configurações → Domínio de aplicações. O endereço automático de sslip.io tem
 * o IP da VPS no nome. Aqui a pessoa define uma base própria (apps.example.com)
 * e cria UM registro curinga no DNS; "Verificar DNS e salvar" consulta um nome
 * aleatório sob a base e só salva se ele chegar a esta VPS. Os projetos novos
 * passam a ganhar <projeto>-<sufixo>.<base>, cada um com a própria rota e o
 * próprio certificado (nada de certificado curinga).
 */
export function AppsDomainSettings() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<AppsDomainStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"verify" | "remove" | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ check: AppsDomainDnsCheck; saved: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<AppsDomainStatus>(PATH));
      setLoadError(null);
    } catch {
      setLoadError(t("panelDomain.apps.load.error"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function verify(domain: string) {
    setBusy("verify");
    setError(null);
    try {
      const r = await apiFetch<AppsDomainVerifyResponse>(`${PATH}/verify`, { method: "POST", body: JSON.stringify({ domain }) });
      setStatus(r.status);
      setResult({ check: r.check, saved: r.saved });
      if (r.saved) {
        setEditing(false);
        setInput("");
      }
    } catch (err) {
      setError(errorText(err, "panelDomain.apps.error.verify"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      setStatus(await apiFetch<AppsDomainStatus>(PATH, { method: "DELETE" }));
      setResult(null);
      setConfirmRemove(false);
    } catch (err) {
      setError(errorText(err, "panelDomain.apps.error.remove"));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void verify(input.trim());
  }

  const errorBox = error && (
    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  );

  if (loadError) {
    return (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {loadError}
      </p>
    );
  }
  if (!status) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const base = status.base;
  const showForm = !base || editing;
  const preview = previewBase(input);
  const previewRecords: AppsDomainRecord[] = preview
    ? [
        { type: "A", name: `*.${preview}`, value: status.serverIp ?? t("panelDomain.apps.record.valueFallback") },
        ...(status.serverIpv6 ? [{ type: "AAAA" as const, name: `*.${preview}`, value: status.serverIpv6 }] : []),
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4" aria-hidden /> {t("panelDomain.apps.title")}
        </CardTitle>
        <CardDescription>{t("panelDomain.apps.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {status.mode === "tunnel" ? (
          <p data-testid="apps-tunnel">{t("panelDomain.apps.tunnel.text")}</p>
        ) : (
          <>
            {showForm ? (
              <form onSubmit={submit} className="flex max-w-lg flex-col gap-3">
                <label htmlFor="apps-domain" className="font-medium">
                  {t("panelDomain.apps.field.label")}
                </label>
                <Input
                  id="apps-domain"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t("panelDomain.apps.field.placeholder")}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                />
                <p className="text-xs text-muted-foreground">{t("panelDomain.apps.field.hint")}</p>
                {editing && base && <p className="text-xs text-amber-400">{t("panelDomain.apps.changeWarning", { base })}</p>}
                {previewRecords.length > 0 && <RecordTable records={previewRecords} />}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="info" disabled={busy !== null || preview === ""}>
                    {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {t("panelDomain.apps.verify")}
                  </Button>
                  {editing && (
                    <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setEditing(false)}>
                      {t("panelDomain.apps.cancel")}
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-3">
                <div data-testid="apps-current" className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono">{base}</span>
                  {status.verified ? (
                    <Badge variant="success">
                      <CheckCircle2 className="h-3 w-3" aria-hidden /> {t("panelDomain.apps.badge.verified")}
                    </Badge>
                  ) : (
                    <Badge variant="warning">
                      <AlertTriangle className="h-3 w-3" aria-hidden /> {t("panelDomain.apps.badge.recheck")}
                    </Badge>
                  )}
                </div>
                {status.example && (
                  <p className="text-xs text-muted-foreground">
                    {t("panelDomain.apps.example")} <code data-testid="apps-example" className="font-mono">{status.example}</code>
                  </p>
                )}
                {status.needsRecheck && (
                  <p
                    role="status"
                    data-testid="apps-recheck"
                    className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-400"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>{t("panelDomain.apps.recheck", { base: base ?? "", ip: status.serverIp ?? t("panelDomain.apps.record.valueFallback") })}</span>
                  </p>
                )}
                <RecordTable records={status.records} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="info" disabled={busy !== null} onClick={() => void verify(base!)}>
                    {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {t("panelDomain.apps.verifyAgain")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setInput(base!);
                      setEditing(true);
                      setConfirmRemove(false);
                      setResult(null);
                    }}
                  >
                    {t("panelDomain.apps.change")}
                  </Button>
                  {!confirmRemove && (
                    <Button variant="danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                      <Trash2 className="h-4 w-4" /> {t("panelDomain.apps.remove")}
                    </Button>
                  )}
                </div>
                {confirmRemove && (
                  <div data-testid="apps-remove-confirm" className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3">
                    <p>
                      {t("panelDomain.apps.removeConfirm", { base: base ?? "" })}
                      {status.projectsUsingBase > 0 && <> {t("panelDomain.apps.removeUsing", { count: status.projectsUsingBase })}</>}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>
                        {t("panelDomain.apps.cancel")}
                      </Button>
                      <Button variant="danger" disabled={busy !== null} onClick={() => void remove()}>
                        {busy === "remove" && <Loader2 className="h-4 w-4 animate-spin" />}
                        {t("panelDomain.apps.removeYes")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {result && <Result check={result.check} saved={result.saved} />}
            {errorBox}
            <div className="flex flex-col gap-2 border-t pt-3 text-xs text-muted-foreground">
              <p>{t("panelDomain.apps.letsEncrypt")}</p>
              <a
                href={appsDomainGuideUrl(locale)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-primary hover:underline"
              >
                <BookOpen className="h-3.5 w-3.5" aria-hidden /> {t("panelDomain.apps.guide")}
              </a>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
