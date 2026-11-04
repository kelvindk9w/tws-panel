import { useId, useState, type FormEvent } from "react";
import {
  MCP_TOKEN_OPTION_KEYS,
  widenedMcpOptions,
  type ApiTokenInfo,
  type McpTokenOptions as McpOptions,
  type UpdateApiTokenMcpRequest,
  type UpdateApiTokenMcpResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { EmailCodeField } from "@/components/settings/EmailCodeField";
import { Loader2, TriangleAlert } from "lucide-react";

const LABEL: Record<keyof McpOptions, { label: Key; desc: Key; name: Key }> = {
  securityApply: { label: "settings.mcpOpt.securityApply.label", desc: "settings.mcpOpt.securityApply.desc", name: "settings.mcpOpt.name.securityApply" },
  secretsRead: { label: "settings.mcpOpt.secretsRead.label", desc: "settings.mcpOpt.secretsRead.desc", name: "settings.mcpOpt.name.secretsRead" },
  skipApproval: { label: "settings.mcpOpt.skipApproval.label", desc: "settings.mcpOpt.skipApproval.desc", name: "settings.mcpOpt.name.skipApproval" },
  metrics: { label: "settings.mcpOpt.metrics.label", desc: "settings.mcpOpt.metrics.desc", name: "settings.mcpOpt.name.metrics" },
};

export const NO_MCP_OPTIONS: McpOptions = { securityApply: false, secretsRead: false, skipApproval: false, metrics: false };

/** As quatro opções do MCP como caixas de marcar, com o risco de cada uma escrito ao lado. */
export function McpOptionsFields({
  value,
  onChange,
  testPrefix,
}: {
  value: McpOptions;
  onChange: (next: McpOptions) => void;
  testPrefix: string;
}) {
  const { t } = useI18n();
  const anyOn = MCP_TOKEN_OPTION_KEYS.some((key) => value[key]);
  return (
    <fieldset className="flex flex-col gap-2" data-testid={`${testPrefix}-fields`}>
      <legend className="mb-1 font-medium">{t("settings.mcpOpt.legend")}</legend>
      <p className="text-xs text-muted-foreground">{t("settings.mcpOpt.intro")}</p>
      {MCP_TOKEN_OPTION_KEYS.map((key) => (
        <label key={key} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-[:checked]:border-amber-500/60">
          <input
            type="checkbox"
            checked={value[key]}
            onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
            className="mt-1"
            data-testid={`${testPrefix}-${key}`}
          />
          <span className="min-w-0">
            <span className="block font-medium">{t(LABEL[key].label)}</span>
            <span className="block text-xs text-muted-foreground">{t(LABEL[key].desc)}</span>
          </span>
        </label>
      ))}
      {anyOn && (
        <p role="note" data-testid={`${testPrefix}-warning`} className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("settings.mcpOpt.warn")}</span>
        </p>
      )}
    </fieldset>
  );
}

/** Linha da lista: que opções do MCP o token tem ligadas. */
export function mcpOptionsLine(t: (key: Key, params?: Record<string, string | number>) => string, mcp: McpOptions): string {
  const on = MCP_TOKEN_OPTION_KEYS.filter((key) => mcp[key]);
  return on.length === 0 ? t("settings.mcpOpt.item.none") : t("settings.mcpOpt.item.line", { list: on.map((key) => t(LABEL[key].name)).join(", ") });
}

/**
 * Editar as opções do MCP de um token que já existe. Ligar uma opção dá mais poder: pede a senha (e o código,
 * com 2FA). Desligar vale na hora, sem senha.
 */
export function McpTokenEditor({
  token,
  twoFactor,
  onSaved,
  onCancel,
}: {
  token: ApiTokenInfo;
  twoFactor: boolean | null;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<McpOptions>({ ...token.mcp });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { password: useId(), code: useId() };
  const widens = widenedMcpOptions(token.mcp, value).length > 0;
  const changed = MCP_TOKEN_OPTION_KEYS.some((key) => value[key] !== token.mcp[key]);
  const ready = changed && (!widens || (password.length > 0 && (twoFactor !== true || code.trim().length > 0))) && !busy;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const body: UpdateApiTokenMcpRequest = {
        mcp: value,
        ...(widens ? { currentPassword: password } : {}),
        ...(widens && twoFactor !== false && code.trim() ? { code: code.trim() } : {}),
        ...(widens && emailCode.trim() ? { emailCode: emailCode.trim() } : {}),
      };
      await apiFetch<UpdateApiTokenMcpResponse>(`/api/settings/api-tokens/${token.id}/mcp`, { method: "PATCH", body: JSON.stringify(body) });
      await onSaved();
    } catch (err) {
      setError(apiErrorText(err, "settings.mcpOpt.error.save"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} data-testid="api-token-mcp-edit" className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3 text-sm">
      <McpOptionsFields value={value} onChange={setValue} testPrefix="mcp-edit" />
      {widens ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{t("settings.mcpOpt.edit.widens")}</p>
          <label htmlFor={ids.password} className="font-medium">
            {t("settings.apiAccess.form.password.label")}
          </label>
          <PasswordInput id={ids.password} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {twoFactor !== false && (
            <>
              <label htmlFor={ids.code} className="font-medium">
                {t("settings.apiAccess.form.code.label")}
              </label>
              <Input id={ids.code} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </>
          )}
          <EmailCodeField idPrefix="mcp-edit" action="token.edit" value={emailCode} onChange={setEmailCode} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("settings.mcpOpt.edit.reduces")}</p>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("settings.mcpOpt.edit.save")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("settings.apiAccess.item.revokeCancel")}
        </Button>
      </div>
    </form>
  );
}
