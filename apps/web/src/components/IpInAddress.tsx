import { AlertTriangle, Info } from "lucide-react";
import { useI18n } from "@/i18n";

/**
 * Endereços de sslip.io têm o IP da VPS no nome (<projeto>.<ip-com-hífens>.sslip.io).
 * Aparecem em prints e links compartilhados, e quebram se o IP mudar. O painel
 * avisa sem tratar como erro: serve para testar; para publicar, domínio próprio.
 */
export function addressHasVpsIp(domain: string | null | undefined): boolean {
  return (domain ?? "").toLowerCase().endsWith(".sslip.io");
}

/**
 * Aviso âmbar do passo 3 do assistente: ícone + título + texto (não só cor),
 * com atalho para "Meu domínio ou subdomínio" e para configurar o Domínio de
 * aplicações. O link abre em outra aba para não perder o assistente.
 */
export function IpAddressWarning({ onUseOwn, hasAppsDomain = false }: { onUseOwn: () => void; hasAppsDomain?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="note"
      data-testid="ip-warning"
      className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-400"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-medium">{t("projects.new.domain.ipWarningTitle")}</p>
        <p>{t("projects.new.domain.ipWarning")}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" onClick={onUseOwn} className="text-left underline underline-offset-2 hover:no-underline">
            {t("projects.new.domain.ipWarningOwn")}
          </button>
          {!hasAppsDomain && (
            <a
              href="/settings/apps-domain"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:no-underline"
            >
              {t("projects.new.domain.ipWarningApps")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Indicador discreto ao lado de um endereço sslip.io já criado (página do
 * projeto e lista de domínios). `compact`: só o ícone (com título e texto para
 * leitor de tela); senão, ícone e texto curtos.
 */
export function IpInAddressHint({ domain, compact = false }: { domain: string | null | undefined; compact?: boolean }) {
  const { t } = useI18n();
  if (!addressHasVpsIp(domain)) return null;
  return (
    <span
      data-testid="ip-in-address"
      title={t("projects.domains.hasIpTitle")}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
    >
      <Info className="h-3 w-3 shrink-0" aria-hidden />
      <span className={compact ? "sr-only" : undefined}>{t("projects.domains.hasIp")}</span>
    </span>
  );
}
