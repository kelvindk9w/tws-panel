import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type {
  TwoFactorConfirmRequest,
  TwoFactorEnableResponse,
  TwoFactorSetupResponse,
  TwoFactorStatusResponse,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, t, Trans, useI18n } from "@/i18n";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, Download, Loader2, Smartphone } from "lucide-react";

type Stage =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "setup"; secret: string; qr: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "on"; recoveryCodesLeft: number };

const bold = { b: <strong className="text-foreground" /> };

/** Chave em grupos de 4 — mais fácil de digitar no app sem errar. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

function downloadCodes(codes: string[]) {
  const text =
    t("settings.twoFactor.file.title") +
    "\n" +
    t("settings.twoFactor.file.note") +
    "\n\n" +
    codes.join("\n") +
    "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "tws-panel-codigos-de-recuperacao.txt";
  a.click();
  URL.revokeObjectURL(url);
}

/** Campos "código do app" + "senha atual", usados para ativar e para desativar. */
function ConfirmFields({
  code,
  setCode,
  password,
  setPassword,
}: {
  code: string;
  setCode: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tf-code" className="text-sm font-medium">
          {t("settings.twoFactor.code.label")}
        </label>
        <Input
          id="tf-code"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("settings.twoFactor.code.placeholder")}
          className="font-mono tracking-widest"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tf-password" className="text-sm font-medium">
          {t("settings.twoFactor.password.label")}
        </label>
        <PasswordInput
          id="tf-password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
    </>
  );
}

/**
 * Verificação em duas etapas do login do painel: ativar (QR + confirmação) e
 * desativar. O painel fica na internet por HTTPS; com isto, a senha sozinha
 * não basta para entrar. Fica em Configurações → Segurança.
 */
export function TwoFactorPanel() {
  const { t } = useI18n();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<TwoFactorStatusResponse>("/api/auth/2fa")
      .then((s) => setStage(s.enabled ? { kind: "on", recoveryCodesLeft: s.recoveryCodesLeft } : { kind: "off" }))
      .catch((err: unknown) => {
        setError(apiErrorText(err, "settings.twoFactor.error.status"));
        setStage({ kind: "off" });
      });
  }, []);

  function resetFields() {
    setCode("");
    setPassword("");
    setError(null);
  }

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<TwoFactorSetupResponse>("/api/auth/2fa/setup", { method: "POST", body: "{}" });
      const svg = await QRCode.toString(res.otpauthUri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      setStage({ kind: "setup", secret: res.secret, qr: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` });
    } catch (err) {
      setError(apiErrorText(err, "settings.twoFactor.error.begin"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent, action: "enable" | "disable") {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: TwoFactorConfirmRequest = { code: code.trim(), currentPassword: password };
      if (action === "enable") {
        const res = await apiFetch<TwoFactorEnableResponse>("/api/auth/2fa/enable", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        resetFields();
        setStage({ kind: "codes", codes: res.recoveryCodes });
      } else {
        await apiFetch("/api/auth/2fa/disable", { method: "POST", body: JSON.stringify(payload) });
        resetFields();
        setStage({ kind: "off" });
      }
    } catch (err) {
      setError(apiErrorText(err, "settings.twoFactor.error.confirm"));
    } finally {
      setBusy(false);
    }
  }

  const canConfirm = code.trim().length > 0 && password.length > 0 && !busy;

  return (
    <div data-testid="two-factor-panel" className="max-w-md">
      <div>

        {stage.kind === "loading" && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {stage.kind === "off" && (
          <div className="flex flex-col gap-3 text-sm">
            <div data-testid="two-factor-intro" className="flex flex-col gap-2 text-muted-foreground">
              <p>
                <Trans k="settings.twoFactor.intro.why" components={bold} />
              </p>
              <p className="flex items-start gap-2">
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <Trans k="settings.twoFactor.intro.app" components={bold} />
                </span>
              </p>
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button onClick={() => void begin()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.twoFactor.begin")}
            </Button>
          </div>
        )}

        {stage.kind === "setup" && (
          <form onSubmit={(e) => void confirm(e, "enable")} className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              <Trans k="settings.twoFactor.setup.scan" components={bold} />
            </p>
            <img
              data-testid="two-factor-qr"
              src={stage.qr}
              alt={t("settings.twoFactor.setup.qrAlt")}
              className="mx-auto h-44 w-44 rounded bg-white p-2"
            />
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{t("settings.twoFactor.setup.manual")}</span>
              <div className="flex items-center justify-between gap-2 rounded bg-black/60 px-2 py-1.5">
                <code data-testid="two-factor-secret" className="break-all font-mono text-emerald-100/90">
                  {groupSecret(stage.secret)}
                </code>
                <CopyButton text={stage.secret} />
              </div>
            </div>
            <p className="text-muted-foreground">
              <Trans k="settings.twoFactor.setup.confirm" components={bold} />
            </p>
            <ConfirmFields code={code} setCode={setCode} password={password} setPassword={setPassword} />
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={!canConfirm}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.twoFactor.enable")}
            </Button>
          </form>
        )}

        {stage.kind === "codes" && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="font-medium text-emerald-400">{t("settings.twoFactor.codes.enabled")}</p>
            <p className="text-muted-foreground">
              <Trans k="settings.twoFactor.codes.keep" components={bold} />
            </p>
            <ul
              data-testid="recovery-codes"
              className="grid grid-cols-2 gap-1 rounded bg-black/60 p-3 font-mono text-emerald-100/90"
            >
              {stage.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <CopyButton text={stage.codes.join("\n")} label={t("settings.twoFactor.codes.copyAll")} />
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => downloadCodes(stage.codes)}>
                <Download className="h-3.5 w-3.5" /> {t("settings.twoFactor.codes.download")}
              </Button>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              {t("settings.twoFactor.codes.saved")}
            </label>
            <Button
              onClick={() => {
                setSaved(false);
                setStage({ kind: "on", recoveryCodesLeft: stage.codes.length });
              }}
              disabled={!saved}
            >
              {t("settings.twoFactor.codes.done")}
            </Button>
          </div>
        )}

        {stage.kind === "on" && (
          <form onSubmit={(e) => void confirm(e, "disable")} className="flex flex-col gap-3 text-sm">
            <div data-testid="two-factor-on" className="flex flex-col gap-1">
              <p className="font-medium text-emerald-400">{t("settings.twoFactor.on.active")}</p>
              <p className="text-muted-foreground">
                {t("settings.twoFactor.on.left", { count: stage.recoveryCodesLeft })}
              </p>
              {stage.recoveryCodesLeft <= 3 && (
                <p data-testid="recovery-low" className="flex items-start gap-1 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {t("settings.twoFactor.on.low")}
                </p>
              )}
            </div>
            <p className="text-muted-foreground">{t("settings.twoFactor.on.disableHint")}</p>
            <ConfirmFields code={code} setCode={setCode} password={password} setPassword={setPassword} />
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" variant="destructive" disabled={!canConfirm}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.twoFactor.disable")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
