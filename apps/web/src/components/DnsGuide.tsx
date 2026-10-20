import { Trans, useI18n } from "@/i18n";

/**
 * Guia do registro de DNS para apontar um domínio próprio para a VPS: o
 * registro exato (tipo A, nome, IP) e onde criá-lo. Usado no Novo Projeto e na
 * seção Domínios do projeto.
 */
export function DnsGuide({ domain, publicIp }: { domain: string; publicIp: string | null }) {
  const { t } = useI18n();
  return (
    <div data-testid="dns-guide" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
      <p>
        <Trans k="setup.dnsGuide.intro" components={{ b: <strong className="text-foreground" /> }} />
      </p>
      <table className="w-full text-left font-mono">
        <thead>
          <tr className="text-muted-foreground">
            <th className="pr-3 font-normal">{t("setup.dnsGuide.colType")}</th>
            <th className="pr-3 font-normal">{t("setup.dnsGuide.colName")}</th>
            <th className="font-normal">{t("setup.dnsGuide.colValue")}</th>
          </tr>
        </thead>
        <tbody className="text-foreground">
          <tr>
            <td className="pr-3">A</td>
            <td className="break-all pr-3">{domain.trim().toLowerCase() || t("setup.dnsGuide.domainExample")}</td>
            <td>{publicIp ?? t("setup.dnsGuide.ipFallback")}</td>
          </tr>
        </tbody>
      </table>
      <p>
        <Trans k="setup.dnsGuide.nameHint" components={{ code: <code />, b: <strong className="text-foreground" /> }} />
      </p>
      <p data-testid="dns-guide-cloudflare">
        <Trans k="setup.dnsGuide.cloudflare" components={{ b: <strong className="text-foreground" /> }} />
      </p>
    </div>
  );
}
