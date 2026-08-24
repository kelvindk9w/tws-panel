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
 */
import { useNavigate } from "react-router";
import { SecurityStep } from "@/pages/setup/SecurityStep";

export function HardeningPage() {
  const navigate = useNavigate();
  const voltar = () => navigate("/security");

  return <SecurityStep onNext={voltar} onBack={voltar} />;
}
