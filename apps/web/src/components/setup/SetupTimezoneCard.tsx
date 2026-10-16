/**
 * Fuso horário no assistente de instalação (passo do diagnóstico): mostra o
 * fuso detectado na VPS e deixa trocar ali mesmo (o mesmo PUT /api/timezone
 * de Configurações → Fuso horário). Nunca trava o assistente: se o host
 * bridge falhar, diz o motivo e o "Continuar" segue funcionando.
 */
import { useEffect, useState } from "react";
import type { SetTimezoneResponse, TimezoneStatus } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimezonePicker, clockIn, zoneWithOffset } from "@/components/timezone/TimezonePicker";
import { CheckCircle2, Clock, Loader2 } from "lucide-react";

export function SetupTimezoneCard() {
  const [status, setStatus] = useState<TimezoneStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [zone, setZone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch<TimezoneStatus>("/api/timezone")
      .then((st) => {
        setStatus(st);
        setZone(st.hostZone ?? st.zone);
      })
      .catch(() => setFailed(true));
  }, []);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<SetTimezoneResponse>("/api/timezone", { method: "PUT", body: JSON.stringify({ zone }) });
      setStatus(res.status);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(
        `${err instanceof ApiRequestError ? err.message : "Não foi possível trocar agora."} Você pode continuar e trocar depois em Configurações → Fuso horário.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const vps = status ? (status.hostZone ?? status.zone) : null;

  return (
    <Card data-testid="setup-timezone">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Clock className="h-4 w-4 text-muted-foreground" /> Fuso horário
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {failed ? (
          <p className="text-muted-foreground">
            Não deu para ler o fuso agora. Você pode continuar e ajustar depois em Configurações → Fuso horário.
          </p>
        ) : !status || !vps ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Lendo o fuso da VPS…
          </p>
        ) : (
          <>
            <p>
              A VPS está em <strong>{zoneWithOffset(vps, status.options)}</strong> ({clockIn(vps, new Date(status.now))} agora). Os
              backups rodam às 03:00 nesse fuso.
            </p>
            {saved && (
              <p className="flex items-start gap-1.5 text-emerald-400">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Fuso trocado.
              </p>
            )}
            {!editing ? (
              status.canApply ? (
                <div>
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                    Trocar o fuso
                  </Button>
                </div>
              ) : (
                status.cannotApplyReason && <p className="text-xs text-muted-foreground">{status.cannotApplyReason}</p>
              )
            ) : (
              <div className="flex flex-col gap-2">
                <TimezonePicker options={status.options} value={zone} onChange={setZone} disabled={busy} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void apply()} disabled={busy || zone === vps}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />} Aplicar na VPS
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            {error && (
              <p role="alert" className="text-amber-400">
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
