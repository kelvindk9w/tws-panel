import type { ReactNode } from "react";
import type { DomainCheckResponse, DomainDnsState, DomainPairOccupant } from "@paas/core";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { CopyButton } from "@/components/mail/CopyButton";
import { Trans, useI18n, type TFunction } from "@/i18n";
import { dnsRecords, typedHost } from "@/lib/dns-records";
import { cn } from "@/lib/utils";

const OCCUPIED_KEY: Record<DomainPairOccupant, "setup.dnsGuide.occupied.other_project" | "setup.dnsGuide.occupied.same_project" | "setup.dnsGuide.occupied.panel" | "setup.dnsGuide.occupied.mail"> = {
  other_project: "setup.dnsGuide.occupied.other_project",
  same_project: "setup.dnsGuide.occupied.same_project",
  panel: "setup.dnsGuide.occupied.panel",
  mail: "setup.dnsGuide.occupied.mail",
};

function stateText(t: TFunction, state: DomainDnsState, ips: string[]): string {
  switch (state) {
    case "pointed":
      return t("setup.dnsGuide.state.pointed");
    case "missing":
      return t("setup.dnsGuide.state.missing");
    case "elsewhere":
      return t("setup.dnsGuide.state.elsewhere", { ips: ips.join(", ") });
    case "cloudflare":
      return t("setup.dnsGuide.state.cloudflare");
    case "unavailable":
      return t("setup.dnsGuide.state.unavailable");
  }
}

/** Uma linha de um registro (Tipo / Nome / Valor): rótulo à esquerda, conteúdo que quebra em vez de rolar. */
function RecordLine({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-2">
      <span className="font-sans text-muted-foreground">{title}</span>
      <div className="min-w-0 break-all">{children}</div>
    </div>
  );
}

function Status({ name, state, ips, warn, testId }: { name: string; state: DomainDnsState; ips: string[]; warn: boolean; testId: string }) {
  const { t } = useI18n();
  const good = state === "pointed";
  return (
    <li data-testid={testId} data-state={state} className={cn("flex items-start gap-2", good ? "text-emerald-400" : "text-amber-400")}>
      {good ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span>
        <span className="break-all font-mono">{name}</span>: {stateText(t, state, ips)}
        {warn && !good && <> {t("setup.dnsGuide.pair.warnOnly")}</>}
      </span>
    </li>
  );
}

/**
 * Guia do DNS para apontar um domínio próprio para a VPS: o registro exato
 * (tipo, nome como se escreve no provedor, valor) com copiar, para o nome
 * digitado E para o par com/sem www (opcional), e o resultado da verificação
 * de cada nome. Usado no Novo Projeto e na seção Domínios do projeto.
 */
export function DnsGuide({
  domain,
  publicIp,
  check = null,
  pairEnabled = true,
  onPairEnabledChange,
}: {
  domain: string;
  publicIp: string | null;
  /** Resultado de /api/domains/check do mesmo nome (mostra o estado de cada nome). */
  check?: DomainCheckResponse | null;
  pairEnabled?: boolean;
  /** Presente = a pessoa pode ligar/desligar o par. */
  onPairEnabledChange?: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const host = typedHost(domain);
  const { rows, pair } = dnsRecords(domain, publicIp, pairEnabled);
  const ipText = publicIp ?? t("setup.dnsGuide.ipFallback");
  const showPairBlock = pair !== null;
  const pairRow = rows.find((r) => r.kind === "pair");
  const occupied = check?.pair?.occupiedBy;
  const states = check ? { main: check.state ?? (check.ok ? "pointed" : null), pair: check.pair } : null;

  function nameCell(label: string, name: string): ReactNode {
    return (
      <>
        <span className="inline-flex items-center gap-1">
          <code>{label}</code>
          <CopyButton text={label} ariaLabel={t("setup.dnsGuide.copyName", { name })} />
        </span>
        <span className="block break-all text-muted-foreground">{name}</span>
      </>
    );
  }

  return (
    <div data-testid="dns-guide" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
      <p>
        <Trans k={rows.length > 1 ? "setup.dnsGuide.introMany" : "setup.dnsGuide.intro"} params={{ count: rows.length }} components={{ b: <strong className="text-foreground" /> }} />
      </p>
      <ul data-testid="dns-guide-records" className="flex flex-col gap-2 font-mono text-foreground">
        {rows.length === 0 ? (
          <li className="flex flex-col gap-1 rounded-md border bg-background/40 p-2">
            <RecordLine title={t("setup.dnsGuide.colType")}>A</RecordLine>
            <RecordLine title={t("setup.dnsGuide.colName")}>{t("setup.dnsGuide.domainExample")}</RecordLine>
            <RecordLine title={t("setup.dnsGuide.colValue")}>{ipText}</RecordLine>
          </li>
        ) : (
          rows.map((r) => (
            <li key={r.kind} data-testid={`dns-row-${r.kind}`} className="flex flex-col gap-1 rounded-md border bg-background/40 p-2">
              <RecordLine title={t("setup.dnsGuide.colType")}>{r.type}</RecordLine>
              <RecordLine title={t("setup.dnsGuide.colName")}>{nameCell(r.label, r.name)}</RecordLine>
              <RecordLine title={t("setup.dnsGuide.colValue")}>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <span className="whitespace-nowrap">{ipText}</span>
                  {r.value && <CopyButton text={r.value} ariaLabel={t("setup.dnsGuide.copyValue", { name: r.name })} />}
                </span>
              </RecordLine>
            </li>
          ))
        )}
      </ul>

      {showPairBlock && pair && (
        <div data-testid="dns-guide-pair" className="flex flex-col gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2">
          {onPairEnabledChange && (
            <label className="flex items-start gap-2 text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={pairEnabled}
                onChange={(e) => onPairEnabledChange(e.target.checked)}
              />
              <span>{t("setup.dnsGuide.pair.toggle", { pair: pair.pair, canonical: host })}</span>
            </label>
          )}
          {pairEnabled && (
            <>
              <p className="flex items-start gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  <Trans
                    k={pair.role === "www" ? "setup.dnsGuide.pair.explainWww" : "setup.dnsGuide.pair.explainApex"}
                    params={{ canonical: host, pair: pair.pair }}
                    components={{ b: <strong className="text-foreground" /> }}
                  />
                </span>
              </p>
              <p data-testid="dns-guide-only-one">
                <Trans k="setup.dnsGuide.pair.onlyOne" params={{ canonical: host, pair: pair.pair }} components={{ b: <strong className="text-foreground" /> }} />
              </p>
              {pairRow?.cname && (
                <p data-testid="dns-guide-cname" className="flex flex-wrap items-center gap-1">
                  <Trans k="setup.dnsGuide.pair.cname" params={{ name: pairRow.name, target: pairRow.cname }} components={{ b: <strong className="text-foreground" /> }} />
                  <CopyButton text={pairRow.cname} ariaLabel={t("setup.dnsGuide.copyCname", { name: pairRow.name })} />
                </p>
              )}
              <p data-testid="dns-guide-apex">
                <Trans k="setup.dnsGuide.pair.apexNote" params={{ apex: pair.apex }} components={{ b: <strong className="text-foreground" />, code: <code /> }} />
              </p>
              {occupied && (
                <p data-testid="dns-guide-occupied" role="note" className="flex items-start gap-2 text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t(OCCUPIED_KEY[occupied], { pair: pair.pair })}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {states && (states.main || (states.pair && pairEnabled)) && (
        <ul data-testid="dns-guide-states" className="flex flex-col gap-1">
          {states.main && <Status testId="dns-state-canonical" name={host} state={states.main} ips={check?.resolvedIps ?? []} warn={false} />}
          {states.pair && pairEnabled && !occupied && (
            <Status testId="dns-state-pair" name={states.pair.domain} state={states.pair.state} ips={states.pair.resolvedIps} warn />
          )}
        </ul>
      )}

      <p>
        <Trans k="setup.dnsGuide.nameHint" components={{ code: <code />, b: <strong className="text-foreground" /> }} />
      </p>
      <p data-testid="dns-guide-cloudflare">
        <Trans k="setup.dnsGuide.cloudflare" components={{ b: <strong className="text-foreground" /> }} />
      </p>
    </div>
  );
}
