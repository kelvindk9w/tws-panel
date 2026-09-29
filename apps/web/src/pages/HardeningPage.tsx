/**
 * Página de hardening fora do wizard de instalação.
 *
 * O fluxo completo (scan → plano → aplicar fase → confirmar acesso) vive em
 * SecurityStep, que era alcançável apenas durante o setup. Depois de concluir
 * a instalação não havia caminho de volta — reaplicar ou revisar o hardening
 * exigia reinstalar o painel.
 *
 * O componente do wizard é reaproveitado inteiro: ele não depende de nenhuma
 * rota de /api/setup, só recebe callbacks de navegação. Aqui os dois levam de
 * volta à página de segurança, em vez de avançar um passo do wizard.
 *
 * O usuário do terminal configurado na instalação (/api/terminal/info, com a
 * sessão de admin) segue como fonte primária do campo da Fase 01, igual ao
 * wizard. O terminal ao vivo também vem junto (autenticado pela sessão).
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { TerminalPanel } from "@/components/TerminalPanel";
import { useTerminalInfo } from "@/lib/terminal-info";
import { SecurityStep } from "@/pages/setup/SecurityStep";

export function HardeningPage() {
  const navigate = useNavigate();
  const voltar = () => navigate("/security");
  const terminalInfo = useTerminalInfo(true);
  const [sshUser, setSshUser] = useState<string | null>(null);

  // O terminal vem junto: é nele que a verificação e as fases rodam e, no
  // modo senha, onde o sudo pede a senha. Sem ele o pedido ficava invisível.
  // Depois do setup o token não vale mais: conecta pela sessão de login.
  return (
    <div className="flex flex-col gap-6">
      <SecurityStep
        onNext={voltar}
        onBack={voltar}
        onSshUserDetected={setSshUser}
        configuredUser={terminalInfo.info?.configuredUser ?? null}
      />
      <TerminalPanel
        enabled
        authMode="session"
        sshUser={sshUser}
        info={terminalInfo.info}
        infoUnavailable={terminalInfo.unavailable}
      />
    </div>
  );
}
