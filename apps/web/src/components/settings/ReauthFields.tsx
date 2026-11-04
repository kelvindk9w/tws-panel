import type { EmailCodeAction } from "@paas/core";
import { useI18n } from "@/i18n";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { EmailCodeField } from "@/components/settings/EmailCodeField";

/** Reautenticação das ações sensíveis: senha do painel, código do app e (se ligado) código por e-mail. */
export interface Reauth {
  password: string;
  code: string;
  emailCode: string;
}

export const EMPTY_REAUTH: Reauth = { password: "", code: "", emailCode: "" };

/** Corpo da requisição para o servidor (o código por e-mail só vai quando preenchido). */
export function reauthPayload(r: Reauth): { currentPassword: string; code: string; emailCode?: string } {
  return {
    currentPassword: r.password,
    code: r.code.trim(),
    ...(r.emailCode.trim() ? { emailCode: r.emailCode.trim() } : {}),
  };
}

export function ReauthFields({
  value,
  onChange,
  idPrefix,
  action,
  forceEmailCode = false,
}: {
  value: Reauth;
  onChange: (next: Reauth) => void;
  idPrefix: string;
  action: EmailCodeAction;
  forceEmailCode?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-password`} className="text-sm font-medium">
          {t("access.reauth.password")}
        </label>
        <PasswordInput
          id={`${idPrefix}-password`}
          autoComplete="current-password"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-code`} className="text-sm font-medium">
          {t("access.reauth.code")}
        </label>
        <Input
          id={`${idPrefix}-code`}
          autoComplete="one-time-code"
          value={value.code}
          onChange={(e) => onChange({ ...value, code: e.target.value })}
          placeholder={t("access.reauth.codePlaceholder")}
          className="font-mono tracking-widest"
        />
      </div>
      <EmailCodeField
        idPrefix={idPrefix}
        action={action}
        force={forceEmailCode}
        value={value.emailCode}
        onChange={(emailCode) => onChange({ ...value, emailCode })}
      />
    </>
  );
}
