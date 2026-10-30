/**
 * Cartão "Rede e proxy" da seção Variáveis: o que o app precisa para confiar no Caddy do painel e ler o IP real do
 * visitante (proxies confiáveis do Laravel, do Next.js, real_ip do nginx…). Cada valor tem botão de copiar.
 */
import { Network } from "lucide-react";
import type { ProjectProxyInfo } from "@paas/core";
import { useI18n } from "@/i18n";
import { CopyButton } from "@/components/CopyButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function Row({ testId, label, help, value, unknown }: { testId: string; label: string; help: string; value: string | null; unknown: string }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        {value ? (
          <>
            <code className="min-w-0 flex-1 [overflow-wrap:anywhere] text-sm">{value}</code>
            <CopyButton text={value} />
          </>
        ) : (
          <span className="text-xs text-amber-300">{unknown}</span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">{help}</span>
    </div>
  );
}

export function ProjectProxyCard({ proxy }: { proxy: ProjectProxyInfo }) {
  const { t } = useI18n();
  const network = proxy.network;
  const names = proxy.variables.join(", ");
  return (
    <Card data-testid="env-proxy-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4" /> {t("env.proxy.title")}
        </CardTitle>
        <CardDescription>{t("env.proxy.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Row testId="proxy-subnet" label={t("env.proxy.subnet.label", { network })} help={t("env.proxy.subnet.help")} value={proxy.subnet} unknown={t("env.proxy.unknown")} />
        <Row testId="proxy-ip" label={t("env.proxy.ip.label", { network })} help={t("env.proxy.ip.help")} value={proxy.ip} unknown={t("env.proxy.unknown")} />
        <div data-testid="proxy-headers" className="flex flex-col gap-1 rounded-md border border-border p-3">
          <span className="text-sm font-medium">{t("env.proxy.headers.label")}</span>
          <ul className="flex flex-col gap-1">
            {proxy.headers.map((h) => (
              <li key={h.name} className="flex items-center gap-2 text-sm">
                <code className="shrink-0">{h.name}</code>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">{h.description}</span>
                <CopyButton text={h.name} />
              </li>
            ))}
          </ul>
          <span className="text-xs text-muted-foreground">{t("env.proxy.headers.help")}</span>
        </div>
        <Row testId="proxy-upstream" label={t("env.proxy.upstream.label")} help={t("env.proxy.upstream.help", { network })} value={proxy.upstream} unknown={t("env.proxy.unknown")} />
        <div data-testid="proxy-variables" className="flex flex-col gap-1 rounded-md border border-border p-3 text-xs text-muted-foreground">
          <strong className="text-sm text-foreground">{t("env.proxy.variables.title")}</strong>
          {proxy.delivered ? (
            <>
              <span>{t("env.proxy.variables.body", { names })}</span>
              <span>{t("env.proxy.variables.compose")}</span>
              {proxy.overridden.length > 0 && <span>{t("env.proxy.variables.overridden", { names: proxy.overridden.join(", ") })}</span>}
            </>
          ) : (
            <span>{t("env.proxy.variables.static")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
