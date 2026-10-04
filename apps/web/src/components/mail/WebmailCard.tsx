/**
 * Card "Webmail" da página E-mail (pedido do dono do produto, 04/10/2026):
 * ler, responder e enviar e-mail das caixas pelo navegador, em
 * https://mail.<domínio>/, sem configurar Outlook ou Gmail. Ativa/desativa
 * o webmail, mostra o estado e um "Abrir webmail" por domínio.
 */
import { useCallback, useEffect, useState } from "react";
import type { WebmailActionResponse, WebmailStatus } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink, Loader2, MailOpen, Play, ShieldAlert, Square } from "lucide-react";

function StateBadge({ status }: { status: WebmailStatus }) {
  if (!status.enabled) return <Badge variant="secondary">desativado</Badge>;
  if (!status.running) return <Badge variant="warning">parado</Badge>;
  return <Badge variant="success">ativo</Badge>;
}

export function WebmailCard({ refreshKey }: { refreshKey?: string } = {}) {
  const [status, setStatus] = useState<WebmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<WebmailStatus>("/api/mail/webmail"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o webmail.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function act(kind: "enable" | "disable") {
    setBusy(kind);
    setError(null);
    setWarning(null);
    try {
      const res = await apiFetch<WebmailActionResponse & { proxyError?: string }>(`/api/mail/webmail/${kind}`, {
        method: "POST",
      });
      setStatus(res.status);
      setConfirmDisable(false);
      if (res.proxyError) {
        setWarning(
          `O webmail foi ${kind === "enable" ? "ativado" : "desativado"}, mas o endereço ainda não foi atualizado ` +
            `(${res.proxyError}). Tente de novo em instantes.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível concluir.");
    } finally {
      setBusy(null);
    }
  }

  const canEnable = Boolean(status?.mailServerRunning) && (status?.links.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <MailOpen className="h-4 w-4" /> Webmail
          </CardTitle>
          {status && <StateBadge status={status} />}
        </div>
        <CardDescription>
          Leia, responda e envie e-mails das caixas pelo navegador, sem configurar Outlook ou Gmail. Cada domínio
          abre em https://mail.&lt;domínio&gt;/.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!status && !error && <p className="text-sm text-muted-foreground">carregando…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {warning && <p className="text-sm text-amber-400">{warning}</p>}
        {status?.message && <p className="text-sm text-muted-foreground">{status.message}</p>}

        {status?.enabled && status.running && status.links.length > 0 && (
          <div className="flex flex-col divide-y rounded-lg border">
            {status.links.map((link) => (
              <div key={link.host} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="min-w-0 flex-1 break-all font-mono text-sm">{link.host}</span>
                <Button variant="info" size="sm" asChild>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" /> Abrir webmail
                  </a>
                </Button>
              </div>
            ))}
          </div>
        )}

        {status?.enabled && !status.tlsVerified && (
          <p className="text-xs text-amber-400">
            O certificado de verdade ainda não foi instalado no servidor de e-mail. O webmail funciona, com a conexão
            interna cifrada, e passa a conferir o certificado sozinho assim que ele for emitido.
          </p>
        )}
        {status && status.blockedIps > 0 && (
          <p className="flex items-center gap-2 text-xs text-amber-400">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {status.blockedIps === 1 ? "1 conexão bloqueada" : `${status.blockedIps} conexões bloqueadas`} agora por
            excesso de senhas erradas (liberadas depois de 1 hora).
          </p>
        )}

        {status && (
          <div className="flex flex-wrap gap-2">
            {(!status.enabled || !status.running) && (
              <Button
                variant="success"
                size="sm"
                disabled={busy !== null || !canEnable}
                onClick={() => void act("enable")}
              >
                {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Ativar webmail
              </Button>
            )}
            {status.enabled &&
              (confirmDisable ? (
                <>
                  <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void act("disable")}>
                    {busy === "disable" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Confirmar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDisable(false)}>
                    Cancelar
                  </Button>
                </>
              ) : (
                <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => setConfirmDisable(true)}>
                  <Square className="h-4 w-4" /> Desativar
                </Button>
              ))}
          </div>
        )}

        {status?.enabled && (
          <p className="text-xs text-muted-foreground">
            Para entrar, use o endereço completo da caixa e a senha dela. Por segurança, a sessão termina depois de
            10 minutos sem uso, e 10 senhas erradas seguidas bloqueiam a conexão por 1 hora.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
