/**
 * Aviso de que o domínio já recebe e-mail em outro servidor (registro MX).
 * Usado na página E-mail e no cadastro do domínio pelo e-mail do projeto.
 */
import { useState } from "react";
import type { ExistingMailInfo } from "@paas/core";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

/**
 * Motivo real (01/10/2026): o dono do produto ia cadastrar o domínio
 * principal da empresa, que recebe e-mail em outro provedor. Seguir o
 * checklist (MX → esta VPS) desviaria todo esse e-mail. O aviso tem de ser
 * impossível de ignorar e seguir exige marcar a confirmação.
 */
export function ExistingMailWarning({
  domain,
  info,
  busy,
  onUseSuggested,
  onConfirm,
  onCancel,
}: {
  domain: string;
  info: ExistingMailInfo;
  busy: boolean;
  onUseSuggested: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const current = info.servers[0];
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-red-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {info.status === "elsewhere"
          ? "Este domínio já recebe e-mail em outro servidor"
          : "Não foi possível confirmar quem recebe o e-mail deste domínio"}
      </p>
      {info.status === "elsewhere" ? (
        <>
          <p>
            Hoje o e-mail de <strong>{domain}</strong> chega em <strong>{current}</strong>. Seguindo o checklist,
            apontar o MX para esta VPS desviaria todo o e-mail que hoje chega em {current} — caixas da empresa
            deixariam de receber mensagens.
          </p>
          <p className="text-xs text-muted-foreground">Servidores atuais (MX): {info.servers.join(", ")}</p>
        </>
      ) : (
        <p>
          A consulta ao registro MX de <strong>{domain}</strong> falhou. Se o domínio já tem e-mail funcionando em
          outro provedor, apontar o MX para esta VPS desviaria esse e-mail.
        </p>
      )}
      <p>
        <strong>Recomendado:</strong> use um subdomínio só para o envio, como <strong>{info.suggestedDomain}</strong>.
        Ele não mexe no e-mail que a empresa já recebe.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onUseSuggested}>
          Usar {info.suggestedDomain} (recomendado)
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
        />
        Entendo que, se eu apontar o MX de {domain} para esta VPS, o e-mail deixa de chegar no servidor atual.
      </label>
      <div>
        <Button variant="destructive" size="sm" disabled={!understood || busy} onClick={onConfirm}>
          Seguir com {domain} mesmo assim
        </Button>
      </div>
    </div>
  );
}

