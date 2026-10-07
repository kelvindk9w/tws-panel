import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type {
  CertificateItem,
  CertificateItemResponse,
  CertificateListResponse,
  CertificateRetryResponse,
} from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { formatDay, modeLabel, ownerLabel, STATE_LABELS, stateVariant } from "@/lib/certificates";
import { certificatePending, useAutoRefresh } from "@/lib/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, RefreshCw, RotateCcw, ShieldCheck, Upload, Zap } from "lucide-react";

const textareaClass =
  "min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

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
          <FileUp className="h-3.5 w-3.5" /> Carregar arquivo
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
      setError(errorText(err, "Não foi possível instalar o certificado."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm text-muted-foreground">
        Use quando você já tem um certificado (comprado ou o wildcard da empresa). Cole o certificado com a cadeia
        (os intermediários) e a chave privada sem senha. A chave fica guardada só no servidor e nunca é mostrada de
        novo. Certificado próprio <strong>não renova sozinho</strong>: o painel avisa 30 e 7 dias antes de vencer.
      </p>
      <PemField id={`cert-${id}`} label="Certificado (PEM, com a cadeia)" accept=".crt,.pem,.cer" value={cert} onChange={setCert} />
      <PemField id={`key-${id}`} label="Chave privada (PEM)" accept=".key,.pem" value={key} onChange={setKey} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="success" disabled={busy || !cert.trim() || !key.trim()} onClick={() => void install()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Instalar certificado
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
      setTracking({ phase: "running", message: `${r.message} Acompanhando por até 2 minutos…` });
      const started = Date.now();
      while (alive.current && Date.now() - started < pollMaxMs) {
        await sleep(pollMs);
        if (!alive.current) return;
        const current = await fetchCurrent();
        if (!current || !alive.current) continue;
        onItem(current);
        if (current.state === "valid" || current.state === "expiring") {
          setTracking({ phase: "done", ok: true, message: "Certificado emitido! O endereço já abre com HTTPS válido." });
          await onValid?.();
          return;
        }
        if (current.state === "failed") {
          setTracking({ phase: "done", ok: false, message: "A emissão falhou de novo. Veja a causa acima, corrija e tente outra vez." });
          return;
        }
      }
      if (alive.current) {
        setTracking({
          phase: "done",
          ok: false,
          message: "Ainda não ficou pronto. O proxy continua tentando sozinho; confira de novo em alguns minutos.",
        });
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "already_valid") await alreadyValid(err.message);
      else setError(errorText(err, "Não foi possível pedir a emissão."));
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
      setError(errorText(err, "Não foi possível voltar para o automático."));
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
        <Badge variant={stateVariant(item.state)}>{STATE_LABELS[item.state]}</Badge>
        <Badge variant="outline">{modeLabel(item)}</Badge>
        <span className="text-xs text-muted-foreground">{ownerLabel(item)}</span>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {item.validTo && (
          <p>
            Emitido por {item.issuer ?? "—"} · válido até {formatDay(item.validTo)}
          </p>
        )}
        {item.mode === "automatic" && item.renewsAround && (
          <p>
            Automático: renova sozinho por volta de {formatDay(item.renewsAround)} (data aproximada — o Let&apos;s
            Encrypt renova cerca de 30 dias antes do fim).
          </p>
        )}
        {item.coveredBy && <p>Usa o certificado próprio instalado em {item.coveredBy} (ele cobre este nome).</p>}
        {item.mode === "manual" && (
          <p className="text-amber-400">
            Certificado próprio: não renova sozinho
            {item.validTo || item.manual ? ` — envie um novo antes de ${formatDay((item.manual?.validTo ?? item.validTo)!)}` : ""}. O painel
            gera um alerta 30 e 7 dias antes do fim.
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
              <summary className="cursor-pointer">Detalhe técnico{item.lastError.at ? ` (${formatDay(item.lastError.at)})` : ""}</summary>
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
          Não é preciso renovar: este certificado está válido e o painel renova sozinho perto do fim. Pedir
          certificados repetidos pode até bloquear o nome por uma semana no Let&apos;s Encrypt (limite de 5 iguais).
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
            Tentar emitir agora
          </Button>
        )}
        {validAuto && (
          <Button variant="ghost" size="sm" onClick={() => setExplainRenew((v) => !v)}>
            Renovar agora?
          </Button>
        )}
        {(canUseOwn || ownManual) && !showForm && (
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setShowForm(true)}>
            <Upload className="h-4 w-4" /> {ownManual ? "Trocar certificado" : "Usar certificado próprio"}
          </Button>
        )}
        {ownManual && !confirmRemove && (
          <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
            <RotateCcw className="h-4 w-4" /> Voltar para automático
          </Button>
        )}
        {ownManual && confirmRemove && (
          <>
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
              Cancelar
            </Button>
            <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void backToAutomatic()}>
              {busy === "remove" && <Loader2 className="h-4 w-4 animate-spin" />} Confirmar e apagar
            </Button>
          </>
        )}
      </div>
      {confirmRemove && (
        <p className="text-xs text-muted-foreground">
          O certificado próprio é apagado do servidor e o painel volta a emitir um automático (Let&apos;s Encrypt). Leva de
          segundos a alguns minutos; nesse meio-tempo o endereço pode mostrar aviso de segurança.
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
  const [data, setData] = useState<CertificateListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<CertificateListResponse>("/api/certificates"));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Não foi possível carregar os certificados."));
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
            <ShieldCheck className="h-6 w-6" /> Certificados
          </h1>
          <p className="text-sm text-muted-foreground">
            O cadeado do HTTPS de cada endereço que este painel serve. No modo automático, o painel emite e renova
            sozinho (Let&apos;s Encrypt). No manual, você envia o seu certificado.
          </p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Conferir de novo
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {data && !data.proxyRunning && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          O proxy (Caddy) que serve os endereços não está rodando, então não dá para conferir os certificados. Ele sobe
          sozinho com o painel e a cada deploy; se continuar assim, reinicie o painel.
        </p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Endereços com HTTPS</CardTitle>
          <CardDescription>Conferido agora, do jeito que um navegador confere.</CardDescription>
        </CardHeader>
        <CardContent>
          {!data && !error && <p className="text-sm text-muted-foreground">conferindo…</p>}
          {data && data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhum endereço com HTTPS ainda. Eles aparecem aqui quando você conecta um domínio a um projeto, ao
              painel ou ao e-mail.
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
