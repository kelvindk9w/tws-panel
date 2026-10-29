import { useEffect } from "react";
import { useLocation } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangePasswordForm } from "@/components/settings/ChangePasswordForm";
import { EmailCodeSettings } from "@/components/settings/EmailCodeSettings";
import { TwoFactorPanel } from "@/components/settings/TwoFactorPanel";
import { useI18n } from "@/i18n";

/** Configurações → Segurança da conta: senha e verificação em duas etapas. */
export function SecuritySettings() {
  const { t } = useI18n();
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
          <CardTitle className="text-base">{t("settings.security.password.title")}</CardTitle>
          <CardDescription>{t("settings.security.password.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
      <Card id="two-factor">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.security.twoFactor.title")}</CardTitle>
          <CardDescription>{t("settings.security.twoFactor.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <TwoFactorPanel />
        </CardContent>
      </Card>
      <Card id="email-code">
        <CardHeader>
          <CardTitle className="text-base">{t("access.emailCode.title")}</CardTitle>
          <CardDescription>{t("access.emailCode.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <EmailCodeSettings />
        </CardContent>
      </Card>
    </div>
  );
}
