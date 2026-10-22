import { useEffect, useRef, useState } from "react";
import type { GitAccessCheckRequest, GitAccessCheckResponse, GitAccessFailureReason } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; branch: string; result: GitAccessCheckResponse }
  | { kind: "failed"; message: string };

const REASON_KEY: Record<GitAccessFailureReason, Key> = {
  invalid_source: "projects.new.access.reason.invalid_source",
  invalid_branch: "projects.new.access.reason.invalid_branch",
  invalid_token: "projects.new.access.reason.invalid_token",
  auth_required: "projects.new.access.reason.auth_required",
  no_permission: "projects.new.access.reason.no_permission",
  not_found: "projects.new.access.reason.not_found",
  not_found_or_no_access: "projects.new.access.reason.not_found_or_no_access",
  branch_not_found: "projects.new.access.branchMissing",
  unsupported_host: "projects.new.access.reason.unsupported_host",
  unreachable: "projects.new.access.reason.unreachable",
  timeout: "projects.new.access.reason.timeout",
  token_not_applicable: "projects.new.access.reason.token_not_applicable",
  account_not_connected: "projects.new.access.reason.account_not_connected",
  account_not_applicable: "projects.new.access.reason.account_not_applicable",
  unknown: "projects.new.access.reason.unknown",
};

/**
 * "Testar acesso": consulta somente leitura ao repositório (ls-remote) com o
 * token digitado — ou com o da conta do GitHub (`useAccount`) — e diz em
 * português se o painel conseguirá clonar. Nada é criado nem guardado, e o
 * token só viaja no corpo do pedido: não é mantido no estado deste componente.
 * Mudou o endereço, a branch ou o token: o resultado antigo some.
 */
export function GitAccessTest({
  source,
  branch,
  token,
  useAccount = false,
}: {
  source: string;
  branch: string;
  token?: string;
  useAccount?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ kind: "idle" });
  // descarta a resposta de uma consulta que já ficou velha (a pessoa mexeu nos campos)
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setState({ kind: "idle" });
  }, [source, branch, token, useAccount]);

  const ready = source.trim() !== "" && (useAccount || (token ?? "").trim() !== "");

  async function run() {
    const mine = ++generation.current;
    setState({ kind: "loading" });
    const body: GitAccessCheckRequest = {
      source: source.trim(),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      ...(useAccount ? { useAccount: true } : { token: (token ?? "").trim() }),
    };
    try {
      const result = await apiFetch<GitAccessCheckResponse>("/api/projects/check-git-access", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (mine === generation.current) setState({ kind: "done", branch: branch.trim(), result });
    } catch (err) {
      if (mine === generation.current) {
        setState({ kind: "failed", message: apiErrorText(err, "projects.new.access.requestFailed") });
      }
    }
  }

  const names = (branches: string[], total: number) => ({
    list: branches.join(", "),
    more: total > branches.length ? t("projects.new.access.ok.more", { n: total - branches.length }) : "",
  });

  let tone: "ok" | "bad" | "wait" | null = null;
  let text = "";
  if (state.kind === "loading") {
    tone = "wait";
    text = t("projects.new.access.loading");
  } else if (state.kind === "failed") {
    tone = "bad";
    text = state.message;
  } else if (state.kind === "done") {
    const r = state.result;
    if (r.ok) {
      tone = "ok";
      const { list, more } = names(r.branches, r.totalBranches);
      text =
        t("projects.new.access.ok") +
        (r.defaultBranch ? t("projects.new.access.ok.default", { branch: r.defaultBranch }) : t("projects.new.access.ok.empty")) +
        (r.branchFound && state.branch ? t("projects.new.access.ok.branchExists", { branch: state.branch }) : "") +
        (r.branches.length > 0 ? t("projects.new.access.ok.branches", { list, more }) : "");
    } else {
      tone = "bad";
      if (r.reason === "branch_not_found") {
        const { list, more } = names(r.branches ?? [], r.totalBranches ?? 0);
        text = t(REASON_KEY.branch_not_found, {
          branch: state.branch,
          default: r.defaultBranch ? t("projects.new.access.branchMissing.default", { branch: r.defaultBranch }) : "",
          list: (r.branches ?? []).length > 0 ? t("projects.new.access.branchMissing.list", { list, more }) : "",
        });
      } else {
        text = t(REASON_KEY[r.reason] ?? REASON_KEY.unknown);
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ready || state.kind === "loading"}
          onClick={() => void run()}
        >
          {state.kind === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {t("projects.new.access.button")}
        </Button>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t("projects.new.access.hint")}
        </span>
      </div>
      {/* região viva sempre presente: leitor de tela anuncia carregando, ok e erro */}
      <div
        role="status"
        aria-live="polite"
        data-testid="git-access-result"
        className={
          "flex items-start gap-2 text-sm [overflow-wrap:anywhere]" +
          (tone === "ok"
            ? " text-emerald-700 dark:text-emerald-300"
            : tone === "bad"
              ? " text-amber-800 dark:text-amber-300"
              : " text-muted-foreground")
        }
      >
        {tone === "ok" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
        {tone === "bad" && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
        {tone === "wait" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />}
        {text && <span className="min-w-0">{text}</span>}
      </div>
    </div>
  );
}
