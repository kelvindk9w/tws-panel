/**
 * UpdateNotice — aviso de "nova atualização do projeto" (só aviso: o deploy continua sendo um clique
 * explícito, no botão Deploy de sempre). Reutilizado em três lugares:
 *  - variant "banner": no topo da página do projeto, só quando há atualização;
 *  - variant "full": na aba Git, com TODOS os estados (atualizado, verificando, desconhecido, erro…)
 *    e o botão "Verificar agora";
 *  - UpdateBadge / UpdateSummary: indicador por projeto e cartão com a lista, no Dashboard.
 *
 * Acessibilidade: o aviso fica numa região de status (leitor de tela anuncia sem roubar o foco),
 * o botão tem rótulo textual, nada pisca nem se move. Layout: quebra linha e nunca estoura a
 * largura (360 px).
 */
import { Link } from "react-router";
import type { ProjectUpdateStatus, UpdateErrorReason } from "@paas/core";
import { formatDateTime, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, HelpCircle, Loader2, RefreshCw, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";

const REASON_KEYS: Record<UpdateErrorReason, Key> = {
  unreachable: "projects.update.reason.unreachable",
  timeout: "projects.update.reason.timeout",
  auth: "projects.update.reason.auth",
  no_permission: "projects.update.reason.no_permission",
  not_found: "projects.update.reason.not_found",
  branch_not_found: "projects.update.reason.branch_not_found",
  redirected: "projects.update.reason.redirected",
  blocked_host: "projects.update.reason.blocked_host",
  unsupported: "projects.update.reason.unsupported",
  unknown: "projects.update.reason.unknown",
};

export interface UpdateNoticeProps {
  /** null = ainda sem resposta. */
  status: ProjectUpdateStatus | null;
  /** O painel não respondeu à consulta (≠ "sem atualização"). */
  failed?: boolean;
  variant: "banner" | "full";
  /** Abre o fluxo de Deploy que já existe (nunca publica sozinho). */
  onDeploy?: () => void;
  deployDisabled?: boolean;
  /** "Verificar agora" (só na aba Git). */
  onCheck?: () => void;
  /** "Verificar agora" em andamento. */
  checking?: boolean;
  /** O servidor recusou o "Verificar agora" por excesso de pedidos (429). */
  limited?: boolean;
}

function DeployButton({ onDeploy, disabled }: { onDeploy?: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  if (!onDeploy) return null;
  return (
    <Button type="button" size="sm" variant="deploy" disabled={disabled} onClick={onDeploy} title={t("projects.detail.deployTooltip")}>
      <Rocket className="h-4 w-4" /> {t("projects.update.deployButton")}
    </Button>
  );
}

export function UpdateNotice({ status, failed, variant, onDeploy, deployDisabled, onCheck, checking, limited }: UpdateNoticeProps) {
  const { t } = useI18n();

  if (variant === "banner") {
    if (status?.state !== "update_available") return null;
    return (
      <div
        role="status"
        data-testid="update-banner-project"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-700 dark:text-sky-200"
      >
        <ArrowUpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 basis-56 break-words">
          {t("projects.update.available", { branch: status.branch ?? "main", remote: status.remoteCommit ?? "" })}
        </span>
        <DeployButton onDeploy={onDeploy} disabled={deployDisabled} />
      </div>
    );
  }

  // variant "full" (aba Git): sempre mostra alguma coisa, e a região avisa o leitor de tela quando muda
  const branch = status?.branch ?? "main";
  let tone = "border-border bg-muted/30 text-muted-foreground";
  let icon = <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
  let text: string;
  let showDeploy = false;

  if (!status && failed) {
    tone = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    icon = <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
    text = t("projects.update.requestFailed");
  } else if (!status || status.state === "checking") {
    icon = <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />;
    text = t("projects.update.checking");
  } else {
    switch (status.state) {
      case "update_available":
        tone = "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-200";
        icon = <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
        text = t("projects.update.available", { branch, remote: status.remoteCommit ?? "" });
        showDeploy = true;
        break;
      case "up_to_date":
        tone = "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
        icon = <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
        text = t("projects.update.upToDate", { branch, commit: status.deployedCommit ?? "" });
        break;
      case "unknown":
        text = t("projects.update.unknown");
        break;
      case "never_deployed":
        text = t("projects.update.neverDeployed", { branch });
        break;
      case "config_changed":
        tone = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
        icon = <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
        text = t("projects.update.configChanged");
        break;
      case "not_applicable":
        text = t("projects.update.notApplicable");
        break;
      case "error":
      default:
        tone = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
        icon = <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
        text = `${t("projects.update.error")} ${t(REASON_KEYS[status.reason ?? "unknown"], { branch })}`;
        break;
    }
  }

  const canCheck = onCheck && status?.state !== "not_applicable" && status?.state !== "never_deployed";
  return (
    <div data-testid="update-notice-git" className={cn("flex flex-col gap-2 rounded-md border px-3 py-2 text-sm", tone)}>
      <div role="status" className="flex items-start gap-2">
        {icon}
        <span className="min-w-0 break-words">{text}</span>
      </div>
      {(showDeploy || canCheck) && (
        <div className="flex flex-wrap items-center gap-2">
          {showDeploy && <DeployButton onDeploy={onDeploy} disabled={deployDisabled} />}
          {canCheck && (
            <Button type="button" size="sm" variant="outline" disabled={checking} onClick={onCheck}>
              <RefreshCw className={cn("h-4 w-4", checking && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
              {t("projects.update.checkNow")}
            </Button>
          )}
          {status?.checkedAt && (
            <span className="text-xs text-muted-foreground">
              {t("projects.update.checkedAt", { when: formatDateTime(status.checkedAt) })}
            </span>
          )}
        </div>
      )}
      {limited && (
        <p role="status" className="text-xs">
          {t("projects.update.rateLimited")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("projects.update.hint")}</p>
    </div>
  );
}

/** Indicador por projeto (cartão do Dashboard): leva ao projeto, onde está o botão Deploy. */
export function UpdateBadge({ projectId, branch }: { projectId: string; branch: string | null }) {
  const { t } = useI18n();
  return (
    <Link
      to={`/projects/${projectId}`}
      data-testid={`update-badge-${projectId}`}
      title={t("dashboard.update.badgeTitle", { branch: branch ?? "main" })}
      className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-300"
    >
      <ArrowUpCircle className="h-3 w-3" aria-hidden="true" /> {t("dashboard.update.badge")}
    </Link>
  );
}

/** Cartão do Dashboard: quantos projetos têm atualização e links para cada um. */
export function UpdateSummary({ items }: { items: Array<{ id: string; name: string; branch: string | null }> }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <section
      aria-label={t("dashboard.update.region")}
      data-testid="update-summary"
      className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-700 dark:text-sky-200"
    >
      <p role="status" className="flex items-center gap-2 font-medium">
        <ArrowUpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("dashboard.update.summary", { count: items.length })}
      </p>
      <ul className="flex flex-col gap-1 pl-6">
        {items.map((item) => (
          <li key={item.id} className="min-w-0 break-words">
            <Link to={`/projects/${item.id}`} className="underline underline-offset-2">
              {item.name}
            </Link>{" "}
            <span className="text-xs opacity-80">({item.branch ?? "main"})</span>
          </li>
        ))}
      </ul>
      <p className="text-xs opacity-80">{t("dashboard.update.summaryHint")}</p>
    </section>
  );
}
