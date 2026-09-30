/**
 * Saúde da máquina fora do assistente de configuração ("Setup concluído" →
 * "Verificar a saúde da máquina"). Reaproveita a tela do assistente — ela não
 * depende de rota de /api/setup — com o terminal ao vivo pela sessão de login,
 * igual à página de hardening.
 */
import { useNavigate } from "react-router";
import { TerminalPanel } from "@/components/TerminalPanel";
import { useTerminalInfo } from "@/lib/terminal-info";
import { HealthStep } from "@/pages/setup/HealthStep";

export function HealthPage() {
  const navigate = useNavigate();
  const terminalInfo = useTerminalInfo(true);
  return (
    <div className="flex flex-col gap-6">
      <HealthStep onNext={() => navigate("/")} onBack={() => navigate("/setup")} />
      <TerminalPanel
        enabled
        authMode="session"
        info={terminalInfo.info}
        infoUnavailable={terminalInfo.unavailable}
      />
    </div>
  );
}
