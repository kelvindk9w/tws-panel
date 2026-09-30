import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { MonitorStateResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Info, Loader2 } from "lucide-react";

/**
 * Configurações → Notificações. Só o que existe de verdade: os alertas
 * aparecem DENTRO do painel (número vermelho em "Alertas") e a verificação
 * automática de segurança roda de tempos em tempos. Aviso fora do painel
 * (e-mail, Telegram…) ainda não existe — e a tela diz isso.
 */
export function NotificationSettings() {
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
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Onde os alertas aparecem</CardTitle>
          <CardDescription>
            Hoje os alertas ficam dentro do painel: o número vermelho ao lado de{" "}
            <Link to="/alerts" className="underline underline-offset-2">
              Alertas
            </Link>{" "}
            mostra quantos estão abertos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p data-testid="no-external-channel" className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Aviso fora do painel (por e-mail ou outro canal) <strong className="text-foreground">ainda não existe</strong>:
              com o painel fechado, você só vê um alerta novo quando entrar nele.
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Verificação automática de segurança</CardTitle>
          <CardDescription>
            De tempos em tempos o painel confere a VPS sozinho (pacotes, portas abertas e mudanças desde a última
            vez) e abre um alerta se achar algo.
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
    </div>
  );
}
