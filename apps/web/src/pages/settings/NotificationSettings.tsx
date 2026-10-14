import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
  type MonitorStateResponse,
  type NotificationHistoryEntry,
  type NotificationKind,
  type NotificationsStatus,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CheckCircle2, Loader2, Mail, MessageCircle, Send } from "lucide-react";

/**
 * Configurações → Notificações: avisos fora do painel quando algo precisa de
 * atenção. Dois canais — Telegram (um robô criado no @BotFather) e e-mail
 * (pelo servidor de e-mail do próprio painel) —, a escolha do que avisa e os
 * últimos envios. A verificação automática de segurança continua aqui.
 */

function errorText(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : "Não foi possível concluir agora. Tente de novo em instantes.";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Run = (path: string, init: RequestInit, okMessage?: string) => Promise<boolean>;

/** Ações de um cartão: chamada à API, ocupado, mensagem de sucesso e erro. */
function useAction(onStatus: (s: NotificationsStatus) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run: Run = async (path, init, okMessage) => {
    setBusy(`${init.method} ${path}`);
    setError(null);
    setNotice(null);
    try {
      onStatus(await apiFetch<NotificationsStatus>(path, init));
      if (okMessage) setNotice(okMessage);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, notice, run };
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {notice && (
        <p className="flex items-start gap-1.5 text-sm text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function TestedBadge({ testedAt }: { testedAt: string | null }) {
  return testedAt ? (
    <Badge variant="success">Testado em {when(testedAt)}</Badge>
  ) : (
    <Badge variant="warning">Falta enviar o teste</Badge>
  );
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function TelegramCard({ status, onStatus }: { status: NotificationsStatus; onStatus: (s: NotificationsStatus) => void }) {
  const t = status.telegram;
  const { busy, error, notice, run } = useAction(onStatus);
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const bot = t.botUsername ?? "";

  return (
    <Card data-testid="telegram-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="h-4 w-4 text-sky-400" /> Telegram
        </CardTitle>
        <CardDescription>Os avisos chegam numa conversa do Telegram, por um robô seu.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {t.state === "none" && (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                No Telegram, abra a conversa com o{" "}
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                  @BotFather
                </a>{" "}
                e mande <code className="text-foreground">/newbot</code>.
              </li>
              <li>Escolha um nome e um @ que termine em “bot” (ex.: avisos_do_meu_painel_bot).</li>
              <li>Ele responde com o token: uma linha como 123456789:ABC… Copie a linha inteira e cole aqui.</li>
            </ol>
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void run("/api/notifications/telegram", { method: "PUT", body: JSON.stringify({ token: token.trim() }) }).then(
                  (ok) => ok && setToken(""),
                );
              }}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label htmlFor="tg-token" className="font-medium">
                  Token do robô
                </label>
                <PasswordInput
                  id="tg-token"
                  revealLabel="token"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="123456789:ABC…"
                />
              </div>
              <Button type="submit" disabled={!token.trim() || busy !== null}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar token
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">O token fica guardado cifrado no servidor e não aparece mais na tela.</p>
          </>
        )}

        {t.state === "awaiting_chat" && (
          <>
            <p>
              Robô <strong>@{bot}</strong> conferido. Agora ligue a conversa onde os avisos vão chegar:
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                  Abrir @{bot}
                </a>{" "}
                no Telegram e tocar em “Começar” (ou mandar <code className="text-foreground">/start</code>). Para um grupo,
                adicione o robô ao grupo e mande uma mensagem lá.
              </li>
              <li>Volte aqui e clique em Conectar: o painel mostra o nome da conversa para você conferir.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void run("/api/notifications/telegram/connect", { method: "POST" })} disabled={busy !== null}>
                {busy?.endsWith("/connect") && <Loader2 className="h-4 w-4 animate-spin" />} Conectar
              </Button>
              <Button variant="outline" onClick={() => void run("/api/notifications/telegram", { method: "DELETE" })} disabled={busy !== null}>
                Trocar robô
              </Button>
            </div>
          </>
        )}

        {t.state === "connected" && (
          <>
            <p className="break-words">
              Conectado à conversa <strong>{t.chatTitle}</strong> pelo robô @{bot}.
            </p>
            <div>
              <TestedBadge testedAt={t.testedAt} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="info"
                onClick={() =>
                  void run("/api/notifications/telegram/test", { method: "POST" }, "Mensagem de teste enviada. Confira no Telegram.")
                }
                disabled={busy !== null}
              >
                {busy?.endsWith("/test") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar teste
              </Button>
              {!confirmRemove ? (
                <Button variant="outline" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                  Desconectar
                </Button>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Apagar o token e parar os avisos?</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setConfirmRemove(false);
                      void run("/api/notifications/telegram", { method: "DELETE" });
                    }}
                  >
                    Sim, desconectar
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
                    Não
                  </Button>
                </span>
              )}
            </div>
          </>
        )}
        <Feedback error={error} notice={notice} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EmailCard({ status, onStatus }: { status: NotificationsStatus; onStatus: (s: NotificationsStatus) => void }) {
  const e = status.email;
  const { busy, error, notice, run } = useAction(onStatus);
  const [text, setText] = useState(e.recipients.join("\n"));
  const saved = e.recipients.length > 0;

  return (
    <Card data-testid="email-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-violet-400" /> E-mail
        </CardTitle>
        <CardDescription>Os avisos chegam por e-mail, enviados pelo servidor de e-mail do próprio painel.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!e.available && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="break-words">
              {saved ? "Os e-mails de aviso não vão sair enquanto isto não for resolvido: " : ""}
              {e.unavailableReason}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/mail">Abrir E-mail</Link>
              </Button>
              {!saved && <span className="text-muted-foreground">Enquanto isso, dá para usar só o Telegram.</span>}
            </div>
          </div>
        )}

        {(e.available || saved) && (
          <>
            {e.from && (
              <p className="break-words text-muted-foreground">
                Os avisos saem de <strong className="text-foreground">{e.from}</strong>.
              </p>
            )}
            <form
              className="flex flex-col gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                void run("/api/notifications/email", { method: "PUT", body: JSON.stringify({ recipients: parseRecipients(text) }) });
              }}
            >
              <label htmlFor="nt-recipients" className="font-medium">
                Endereços que recebem (até 5, um por linha ou separados por vírgula)
              </label>
              <textarea
                id="nt-recipients"
                className={textareaClass}
                value={text}
                onChange={(ev) => setText(ev.target.value)}
                placeholder="voce@exemplo.com.br"
                spellCheck={false}
              />
              <div>
                <Button type="submit" disabled={!text.trim() || busy !== null}>
                  {busy === "PUT /api/notifications/email" && <Loader2 className="h-4 w-4 animate-spin" />} Salvar endereços
                </Button>
              </div>
            </form>
            {saved && (
              <>
                <div>
                  <TestedBadge testedAt={e.testedAt} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="info"
                    onClick={() =>
                      void run(
                        "/api/notifications/email/test",
                        { method: "POST" },
                        "E-mail de teste enviado. Confira a caixa de entrada (e o spam, no primeiro envio).",
                      )
                    }
                    disabled={busy !== null || !e.available}
                  >
                    {busy?.endsWith("/test") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar teste
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void run("/api/notifications/email", { method: "DELETE" }).then((ok) => ok && setText(""));
                    }}
                    disabled={busy !== null}
                  >
                    Desligar e-mail
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        <Feedback error={error} notice={notice} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// O que avisa
// ---------------------------------------------------------------------------

function KindsCard({ status, onStatus }: { status: NotificationsStatus; onStatus: (s: NotificationsStatus) => void }) {
  const { busy, error, run } = useAction(onStatus);
  const anyChannel = status.telegram.state === "connected" || status.email.recipients.length > 0;

  function toggle(kind: NotificationKind, value: boolean) {
    void run("/api/notifications/kinds", { method: "PUT", body: JSON.stringify({ kinds: { [kind]: value } }) });
  }

  return (
    <Card data-testid="kinds-card">
      <CardHeader>
        <CardTitle className="text-base">O que avisa</CardTitle>
        <CardDescription>
          Repetidos do mesmo assunto em 10 minutos viram um resumo, e cada canal manda no máximo 20 avisos por hora.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!anyChannel && <p className="text-muted-foreground">Conecte o Telegram ou o e-mail acima para os avisos começarem a sair.</p>}
        <ul className="flex flex-col gap-3">
          {NOTIFICATION_KINDS.map((kind) => (
            <li key={kind} className="flex items-start gap-3">
              <input
                id={`kind-${kind}`}
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-sky-600"
                checked={status.kinds[kind]}
                disabled={busy !== null}
                onChange={(ev) => toggle(kind, ev.target.checked)}
              />
              <label htmlFor={`kind-${kind}`} className="min-w-0">
                <span className="font-medium">{NOTIFICATION_KIND_LABELS[kind].title}</span>
                <span className="block text-muted-foreground">{NOTIFICATION_KIND_LABELS[kind].description}</span>
              </label>
            </li>
          ))}
        </ul>
        <Feedback error={error} notice={null} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<NotificationHistoryEntry["status"], { label: string; variant: "success" | "destructive" | "warning" }> = {
  sent: { label: "Enviado", variant: "success" },
  failed: { label: "Falhou", variant: "destructive" },
  retrying: { label: "Tentando de novo", variant: "warning" },
};

function HistoryCard({ history }: { history: NotificationHistoryEntry[] }) {
  return (
    <Card data-testid="history-card">
      <CardHeader>
        <CardTitle className="text-base">Últimos envios</CardTitle>
        <CardDescription>Só o assunto de cada aviso; o conteúdo não fica guardado.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {history.length === 0 ? (
          <p className="text-muted-foreground">Nenhum aviso enviado ainda.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {history.slice(0, 20).map((h) => {
              const badge = STATUS_BADGE[h.status];
              return (
                <li key={h.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground sm:w-28">{when(h.at)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground sm:w-16">{h.channel === "telegram" ? "Telegram" : "E-mail"}</span>
                  <span className="min-w-0 flex-1 break-words">
                    {h.title}
                    {h.detail && <span className="block text-xs text-muted-foreground">{h.detail}</span>}
                  </span>
                  <span className="shrink-0">
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Verificação automática de segurança (já existia)
// ---------------------------------------------------------------------------

function MonitorIntervalCard() {
  const [hours, setHours] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<MonitorStateResponse>("/api/security/monitor/last")
      .then((res) => setHours(String(Math.round(res.config.intervalMs / 3_600_000))))
      .catch(() => setError("Não foi possível carregar a frequência da verificação automática."));
  }, []);

  async function save() {
    const value = Number(hours);
    if (!Number.isFinite(value) || value < 1 || value > 168) {
      setError("Informe um número de horas entre 1 e 168 (uma semana).");
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await apiFetch("/api/security/monitor/config", {
        method: "PUT",
        body: JSON.stringify({ intervalMs: Math.round(value * 3_600_000) }),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Verificação automática de segurança</CardTitle>
        <CardDescription>
          De tempos em tempos o painel confere a VPS sozinho (pacotes, portas abertas e mudanças desde a última vez) e
          abre um alerta se achar algo — e o alerta vira aviso, se “Alertas de segurança” estiver ligado acima.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hours === null && !error ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="nt-hours" className="text-sm font-medium">
                A cada quantas horas
              </label>
              <Input
                id="nt-hours"
                type="number"
                min={1}
                max={168}
                value={hours ?? ""}
                onChange={(e) => {
                  setHours(e.target.value);
                  setSaved(false);
                }}
                className="w-28"
              />
            </div>
            <Button onClick={() => void save()} disabled={saving || hours === null}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
            </Button>
            {saved && (
              <span className="flex items-center gap-1 pb-2 text-xs text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> Salvo.
              </span>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function NotificationSettings() {
  const [status, setStatus] = useState<NotificationsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    apiFetch<NotificationsStatus>("/api/notifications")
      .then(setStatus)
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Receba um aviso fora do painel quando algo precisar da sua atenção — sem precisar abrir o painel para ver os{" "}
        <Link to="/alerts" className="underline underline-offset-2">
          Alertas
        </Link>
        . Use o Telegram, o e-mail ou os dois.
      </p>
      {loadError && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-destructive">{loadError}</span>
          <Button variant="outline" size="sm" onClick={load}>
            Tentar de novo
          </Button>
        </div>
      )}
      {!status && !loadError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {status && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <TelegramCard status={status} onStatus={setStatus} />
            <EmailCard status={status} onStatus={setStatus} />
          </div>
          <KindsCard status={status} onStatus={setStatus} />
          <HistoryCard history={status.history} />
        </>
      )}
      <MonitorIntervalCard />
    </div>
  );
}
