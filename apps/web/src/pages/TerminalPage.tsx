/**
 * Terminal do servidor numa tela própria (Menu → Terminal). Só o terminal:
 * não dispara verificação nem aplicação de segurança, nem checagem de saúde.
 * Habilitado pela mesma porta de sempre (TerminalGate: senha + 2FA).
 */
import { TerminalPanel } from "@/components/TerminalPanel";
import { TerminalGate } from "@/components/TerminalGate";
import { useTerminalInfo } from "@/lib/terminal-info";
import { useI18n } from "@/i18n";

export function TerminalPage() {
  const { t } = useI18n();
  const terminalInfo = useTerminalInfo(true);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("terminal.page.title")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t("terminal.page.intro")}</p>
      </div>
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
