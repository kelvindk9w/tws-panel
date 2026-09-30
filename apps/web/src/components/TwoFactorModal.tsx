import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type {
  TwoFactorConfirmRequest,
  TwoFactorEnableResponse,
  TwoFactorSetupResponse,
  TwoFactorStatusResponse,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle, Download, Loader2, ShieldCheck, Smartphone, X } from "lucide-react";

type Stage =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "setup"; secret: string; qr: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "on"; recoveryCodesLeft: number };

/** Chave em grupos de 4 — mais fácil de digitar no app sem errar. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

function downloadCodes(codes: string[]) {
  const text =
    "TWS Panel — códigos de recuperação da verificação em duas etapas\n" +
    "Cada código funciona UMA vez, no lugar do código do app, se você perder o celular.\n\n" +
    codes.join("\n") +
    "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "tws-panel-codigos-de-recuperacao.txt";
  a.click();
  URL.revokeObjectURL(url);
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
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
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tf-code" className="text-sm font-medium">
          Código que aparece no app
        </label>
        <Input
          id="tf-code"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123 456"
          className="font-mono tracking-widest"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tf-password" className="text-sm font-medium">
          Sua senha atual do painel
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
 * não basta para entrar.
 */
export function TwoFactorModal({ onClose }: { onClose: () => void }) {
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
        setError(messageOf(err, "Não foi possível consultar a verificação em duas etapas."));
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
      setError(messageOf(err, "Não foi possível começar a configuração."));
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
      setError(messageOf(err, "Não foi possível concluir. Tente novamente."));
    } finally {
      setBusy(false);
    }
  }

  const canConfirm = code.trim().length > 0 && password.length > 0 && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-6" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-4 w-4" /> Verificação em duas etapas
          </h2>
          {stage.kind !== "codes" && (
            <button type="button" onClick={onClose} aria-label="Fechar" className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {stage.kind === "loading" && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {stage.kind === "off" && (
          <div className="flex flex-col gap-3 text-sm">
            <div data-testid="two-factor-intro" className="flex flex-col gap-2 text-muted-foreground">
              <p>
                Hoje, quem descobrir a sua senha entra no painel. Com a verificação em duas etapas, entrar
                exige também um <strong className="text-foreground">código de 6 dígitos</strong> que muda a
                cada 30 segundos no seu celular.
              </p>
              <p className="flex items-start gap-2">
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Instale no celular um app autenticador gratuito: <strong className="text-foreground">Google Authenticator</strong>,{" "}
                  <strong className="text-foreground">Microsoft Authenticator</strong> ou outro de sua preferência.
                </span>
              </p>
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button onClick={() => void begin()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Começar
            </Button>
          </div>
        )}

        {stage.kind === "setup" && (
          <form onSubmit={(e) => void confirm(e, "enable")} className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              <strong className="text-foreground">1.</strong> No app autenticador, toque em adicionar (+) e aponte a
              câmera para o QR code:
            </p>
            <img
              data-testid="two-factor-qr"
              src={stage.qr}
              alt="QR code para o app autenticador"
              className="mx-auto h-44 w-44 rounded bg-white p-2"
            />
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>Não consegue ler o QR? Escolha "inserir chave" no app e digite:</span>
              <div className="flex items-center justify-between gap-2 rounded bg-black/60 px-2 py-1.5">
                <code data-testid="two-factor-secret" className="break-all font-mono text-emerald-100/90">
                  {groupSecret(stage.secret)}
                </code>
                <CopyButton text={stage.secret} />
              </div>
            </div>
            <p className="text-muted-foreground">
              <strong className="text-foreground">2.</strong> Digite o código que o app mostra, para provar que ficou
              configurado. Até aqui nada mudou no seu login.
            </p>
            <ConfirmFields code={code} setCode={setCode} password={password} setPassword={setPassword} />
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={!canConfirm}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Ativar
            </Button>
          </form>
        )}

        {stage.kind === "codes" && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="font-medium text-emerald-400">Verificação em duas etapas ativada.</p>
            <p className="text-muted-foreground">
              Guarde estes <strong className="text-foreground">códigos de recuperação</strong> fora do celular (num
              gerenciador de senhas ou impressos). Se você perder o celular, cada um entra no lugar do código do app,
              uma vez. Eles <strong className="text-foreground">só aparecem agora</strong>.
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
              <CopyButton text={stage.codes.join("\n")} label="Copiar todos" />
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => downloadCodes(stage.codes)}>
                <Download className="h-3.5 w-3.5" /> Baixar .txt
              </Button>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              Guardei os códigos em lugar seguro
            </label>
            <Button onClick={onClose} disabled={!saved}>
              Concluir
            </Button>
          </div>
        )}

        {stage.kind === "on" && (
          <form onSubmit={(e) => void confirm(e, "disable")} className="flex flex-col gap-3 text-sm">
            <div data-testid="two-factor-on" className="flex flex-col gap-1">
              <p className="font-medium text-emerald-400">Ativa: entrar no painel exige o código do app.</p>
              <p className="text-muted-foreground">
                Restam {stage.recoveryCodesLeft} códigos de recuperação.
              </p>
              {stage.recoveryCodesLeft <= 3 && (
                <p data-testid="recovery-low" className="flex items-start gap-1 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  Estão acabando. Para gerar novos, desative e ative de novo.
                </p>
              )}
            </div>
            <p className="text-muted-foreground">Para desativar, confirme com a sua senha e um código do app:</p>
            <ConfirmFields code={code} setCode={setCode} password={password} setPassword={setPassword} />
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" variant="destructive" disabled={!canConfirm}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Desativar
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
