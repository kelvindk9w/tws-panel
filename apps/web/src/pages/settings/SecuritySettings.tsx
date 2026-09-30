import { useEffect } from "react";
import { useLocation } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangePasswordForm } from "@/components/settings/ChangePasswordForm";
import { TwoFactorPanel } from "@/components/settings/TwoFactorPanel";

/** Configurações → Segurança da conta: senha e verificação em duas etapas. */
export function SecuritySettings() {
  const location = useLocation();
  // "Verificação em duas etapas" no menu do usuário e o aviso do Dashboard
  // chegam com #two-factor: leva direto ao card.
  useEffect(() => {
    if (location.hash === "#two-factor") document.getElementById("two-factor")?.scrollIntoView?.({ block: "start" });
  }, [location.hash]);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Senha</CardTitle>
          <CardDescription>Trocar a senha encerra as outras sessões abertas; esta continua.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
      <Card id="two-factor">
        <CardHeader>
          <CardTitle className="text-base">Verificação em duas etapas</CardTitle>
          <CardDescription>Exige também um código do seu celular para entrar no painel.</CardDescription>
        </CardHeader>
        <CardContent>
          <TwoFactorPanel />
        </CardContent>
      </Card>
    </div>
  );
}
