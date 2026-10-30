/**
 * Saúde da máquina fora do assistente de configuração ("Setup concluído" →
 * "Verificar a saúde da máquina"). Reaproveita a tela do assistente — ela não
 * depende de rota de /api/setup — com o terminal ao vivo pela sessão de login,
 * igual à página de hardening. Aqui (já com sessão) também fica o Docker e BuildKit, com a correção do buildx.
 */
import { useNavigate } from "react-router";
import { TerminalPanel } from "@/components/TerminalPanel";
import { TerminalGate } from "@/components/TerminalGate";
import { useTerminalInfo } from "@/lib/terminal-info";
import { HealthStep } from "@/pages/setup/HealthStep";
import { DockerBuildCard } from "@/components/DockerBuildCard";

export function HealthPage() {
  const navigate = useNavigate();
  const terminalInfo = useTerminalInfo(true);
  return (
    <div className="flex flex-col gap-6">
      <HealthStep onNext={() => navigate("/")} onBack={() => navigate("/setup")} />
      <DockerBuildCard />
      <TerminalGate>
        {({ onDisabled }) => (
          <TerminalPanel
            enabled
            authMode="session"
            info={terminalInfo.info}
            infoUnavailable={terminalInfo.unavailable}
            onDisabled={onDisabled}
          />
        )}
      </TerminalGate>
    </div>
  );
}
