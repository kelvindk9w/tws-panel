import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type {
  CertificateItem,
  CertificateItemResponse,
  CertificateListResponse,
  CertificateRetryResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { formatDay, modeLabel, ownerLabel, STATE_KEYS, stateVariant } from "@/lib/certificates";
import { certificatePending, useAutoRefresh } from "@/lib/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, RefreshCw, RotateCcw, ShieldCheck, Upload, Zap } from "lucide-react";

const textareaClass =
  "min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Campo de PEM: colar o texto ou carregar o arquivo. */
function PemField({
  id,
  label,
  accept,
  value,
  onChange,
}: {
  id: string;
  label: string;
  accept: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  async function load(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onChange(await file.text());
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-sky-400 hover:underline">
          <FileUp className="h-3.5 w-3.5" /> {t("certificates.pem.loadFile")}
          <input type="file" accept={accept} className="sr-only" onChange={(e) => void load(e)} />
        </label>
      </div>
      <textarea id={id} className={textareaClass} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}

function ManualForm({
  host,
  onDone,
  onCancel,
}: {
  host: string;
  onDone: (item: CertificateItem) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = host.replace(/[^a-z0-9]/gi, "-");

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<CertificateItemResponse>(`/api/certificates/${encodeURIComponent(host)}/manual`, {
        method: "PUT",
        body: JSON.stringify({ certificate: cert, privateKey: key }),
      });
      setKey("");
      onDone(r.item);
    } catch (err) {
      setError(apiErrorText(err, "certificates.manual.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">
        <Trans k="certificates.manual.intro" components={{ strong: <strong /> }} />
      </p>
      <PemField id={`cert-${id}`} label={t("certificates.manual.certLabel")} accept=".crt,.pem,.cer" value={cert} onChange={setCert} />
      <PemField id={`key-${id}`} label={t("certificates.manual.keyLabel")} accept=".key,.pem" value={key} onChange={setKey} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t("certificates.manual.cancel")}
        </Button>
        <Button variant="success" disabled={busy || !cert.trim() || !key.trim()} onClick={() => void install()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {t("certificates.manual.install")}
        </Button>
      </div>
    </div>
  );
}

type Tracking =
  | { phase: "running"; message: string }
  | { phase: "done"; ok: boolean; message: string };

/**
 * Um nome com o seu certificado e as ações. `onValid`: o card descobriu que
 * o certificado ficou válido (depois de "Tentar emitir agora", ou o servidor
 * respondeu que ele já estava válido) — a tela que o contém atualiza o que
 * depende disso (ex.: Domínio do painel).
 */
export function CertificateCard({
  item,
  onItem,
  onValid,
  pollMs,
  pollMaxMs,
}: {
  item: CertificateItem;
  onItem: (item: CertificateItem) => void;
  onValid?: () => unknown;
  pollMs: number;
  pollMaxMs: number;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"retry" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [explainRenew, setExplainRenew] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const path = `/api/certificates/${encodeURIComponent(item.host)}`;

  const fetchCurrent = () =>
    apiFetch<CertificateListResponse>(`/api/certificates?host=${encodeURIComponent(item.host)}`)
      .then((list) => list.items[0] ?? null)
      .catch(() => null);

  /**
   * O servidor respondeu que o certificado já está válido (ficou pronto
   * enquanto a tela estava aberta): atualiza a tela na hora, em vez de só
   * mostrar a mensagem.
   */
  async function alreadyValid(message: string) {
    const current = await fetchCurrent();
    if (!alive.current) return;
    if (current) onItem(current);
    setTracking({ phase: "done", ok: true, message });
    await onValid?.();
  }

  async function retry() {
    setBusy("retry");
    setError(null);
    setTracking(null);
    try {
      const r = await apiFetch<CertificateRetryResponse>(`${path}/retry`, { method: "POST" });
      setTracking({ phase: "running", message: t("certificates.card.tracking.running", { message: r.message }) });
      const started = Date.now();
      while (alive.current && Date.now() - started < pollMaxMs) {
        await sleep(pollMs);
        if (!alive.current) return;
        const current = await fetchCurrent();
        if (!current || !alive.current) continue;
        onItem(current);
        if (current.state === "valid" || current.state === "expiring") {
          setTracking({ phase: "done", ok: true, message: t("certificates.card.tracking.issued") });
          await onValid?.();
          return;
        }
        if (current.state === "failed") {
          setTracking({ phase: "done", ok: false, message: t("certificates.card.tracking.failedAgain") });
          return;
        }
      }
      if (alive.current) {
        setTracking({
          phase: "done",
          ok: false,
          message: t("certificates.card.tracking.notReady"),
        });
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "already_valid") await alreadyValid(apiErrorText(err, "certificates.card.error.retry"));
      else setError(apiErrorText(err, "certificates.card.error.retry"));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function backToAutomatic() {
    setBusy("remove");
    setError(null);
    try {
      const r = await apiFetch<CertificateItemResponse>(`${path}/manual`, { method: "DELETE" });
      setConfirmRemove(false);
      onItem(r.item);
    } catch (err) {
      setError(apiErrorText(err, "certificates.card.error.backToAuto"));
    } finally {
      setBusy(null);
    }
  }

  const ownManual = item.mode === "manual" && item.coveredBy === null;
  const canUseOwn = item.mode === "automatic";
  const validAuto = item.mode === "automatic" && (item.state === "valid" || item.state === "expiring");

  return (
    <li data-testid={`cert-${item.host}`} className="flex flex-col gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-sm">{item.host}</span>
        <Badge variant={stateVariant(item.state)}>{t(STATE_KEYS[item.state])}</Badge>
        <Badge variant="outline">{modeLabel(item)}</Badge>
        <span className="text-xs text-muted-foreground">{ownerLabel(item)}</span>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {item.validTo && (
          <p>
            {t("certificates.card.issuedBy", { issuer: item.issuer ?? "—", date: formatDay(item.validTo) })}
          </p>
        )}
        {item.mode === "automatic" && item.renewsAround && (
          <p>
            {t("certificates.card.renewsAround", { date: formatDay(item.renewsAround) })}
          </p>
        )}
        {item.coveredBy && <p>{t("certificates.card.coveredBy", { host: item.coveredBy })}</p>}
        {item.mode === "manual" && (
          <p className="text-amber-400">
            {t("certificates.card.manualWarning", {
              extra:
                item.validTo || item.manual
                  ? t("certificates.card.manualWarning.extra", { date: formatDay((item.manual?.validTo ?? item.validTo)!) })
                  : "",
            })}
          </p>
        )}
      </div>

      {item.lastError && (
        <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <p className="flex items-start gap-2 text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{item.lastError.message}</span>
          </p>
          {item.lastError.detail && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">{t("certificates.card.errorDetail")}{item.lastError.at ? ` (${formatDay(item.lastError.at)})` : ""}</summary>
              <p className="mt-1 break-all font-mono">{item.lastError.detail}</p>
            </details>
          )}
        </div>
      )}

      {tracking && (
        <p
          className={
            tracking.phase === "running"
              ? "flex items-center gap-2 text-sm text-sky-400"
              : tracking.ok
                ? "flex items-center gap-2 text-sm text-emerald-400"
                : "flex items-center gap-2 text-sm text-amber-400"
          }
        >
          {tracking.phase === "running" ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : tracking.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          {tracking.message}
        </p>
      )}
      {explainRenew && (
        <p className="text-sm text-muted-foreground">
          {t("certificates.card.explainRenew")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {item.canRetry && (
          <Button variant="info" size="sm" disabled={busy !== null} onClick={() => void retry()}>
            {busy === "retry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {t("certificates.card.retry")}
          </Button>
        )}
        {validAuto && (
          <Button variant="ghost" size="sm" onClick={() => setExplainRenew((v) => !v)}>
            {t("certificates.card.renewQ")}
          </Button>
        )}
        {(canUseOwn || ownManual) && !showForm && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setShowForm(true)}>
            <Upload className="h-4 w-4" /> {ownManual ? t("certificates.card.replaceCert") : t("certificates.card.useOwn")}
          </Button>
        )}
        {ownManual && !confirmRemove && (
          <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
            <RotateCcw className="h-4 w-4" /> {t("certificates.card.backToAuto")}
          </Button>
        )}
        {ownManual && confirmRemove && (
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
              {t("certificates.card.cancel")}
            </Button>
            <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void backToAutomatic()}>
              {busy === "remove" && <Loader2 className="h-4 w-4 animate-spin" />} {t("certificates.card.confirmRemove")}
            </Button>
          </>
        )}
      </div>
      {confirmRemove && (
        <p className="text-xs text-muted-foreground">
          {t("certificates.card.removeNote")}
        </p>
      )}

      {showForm && (
        <ManualForm
          host={item.host}
          onCancel={() => setShowForm(false)}
          onDone={(next) => {
            setShowForm(false);
            onItem(next);
          }}
        />
      )}
    </li>
  );
}

/**
 * Certificados: todos os nomes que o painel serve por HTTPS (painel,
 * domínios dos projetos, servidor de e-mail), com o estado conferido de
 * verdade e as ações — emitir agora (automático) ou usar um certificado
 * próprio (manual).
 *
 * `pollMs`/`pollMaxMs`: acompanhamento depois de "Tentar emitir agora"
 * (padrão: a cada 10 s, por até 2 min). Fora isso, enquanto algum nome
 * automático estiver sem certificado válido, a página consulta sozinha
 * (lib/auto-refresh.ts), pausando com a aba oculta.
 */
export function CertificatesPage({ pollMs = 10_000, pollMaxMs = 120_000 }: { pollMs?: number; pollMaxMs?: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<CertificateListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<CertificateListResponse>("/api/certificates"));
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "certificates.page.error.load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Consulta automática: em silêncio (uma falha mantém a lista como está).
  const quietLoad = useCallback(async () => {
    const next = await apiFetch<CertificateListResponse>("/api/certificates").catch(() => null);
    if (next) setData(next);
  }, []);
  useAutoRefresh(data?.items.some(certificatePending) ?? false, quietLoad);

  const replace = useCallback((next: CertificateItem) => {
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.host === next.host ? next : i)) } : d));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ShieldCheck className="h-6 w-6" /> {t("certificates.page.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("certificates.page.subtitle")}
          </p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t("certificates.page.recheck")}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {data && !data.proxyRunning && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("certificates.page.proxyDown")}
        </p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("certificates.list.title")}</CardTitle>
          <CardDescription>{t("certificates.list.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!data && !error && <p className="text-sm text-muted-foreground">{t("certificates.list.checking")}</p>}
          {data && data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("certificates.list.empty")}
            </p>
          )}
          {data && data.items.length > 0 && (
            <ul className="flex flex-col gap-3">
              {data.items.map((item) => (
                <CertificateCard key={item.host} item={item} onItem={replace} pollMs={pollMs} pollMaxMs={pollMaxMs} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
