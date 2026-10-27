import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router";
import type {
  CloudflareApplyResponse,
  CloudflareDnsScope,
  CloudflareItemStatus,
  CloudflarePlanItem,
  CloudflarePlanResponse,
  CloudflareStatus,
} from "@paas/core";
import { AlertTriangle, CheckCircle2, CloudCog, Info, Loader2, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const STATUS_KEY: Record<CloudflareItemStatus, Key> = {
  create: "cloudflare.status.create",
  ok: "cloudflare.status.ok",
  differs: "cloudflare.status.differs",
  merge: "cloudflare.status.merge",
  conflict: "cloudflare.status.conflict",
  no_zone: "cloudflare.status.no_zone",
};

const STATUS_VARIANT: Record<CloudflareItemStatus, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  create: "secondary",
  ok: "success",
  differs: "warning",
  merge: "warning",
  conflict: "destructive",
  no_zone: "outline",
};

const REASON_KEY: Record<string, Key> = {
  other_mx: "cloudflare.reason.other_mx",
  cname: "cloudflare.reason.cname",
  multiple: "cloudflare.reason.multiple",
  proxied: "cloudflare.reason.proxied",
  spf_multiple: "cloudflare.reason.spf_multiple",
  spf_redirect: "cloudflare.reason.spf_redirect",
  spf_covers: "cloudflare.reason.spf_covers",
};

const OUTCOME_KEY = {
  created: "cloudflare.result.created",
  updated: "cloudflare.result.updated",
  skipped: "cloudflare.result.skipped",
  failed: "cloudflare.result.failed",
} as const satisfies Record<string, Key>;

function StatusIcon({ status }: { status: CloudflareItemStatus }) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
    case "conflict":
      return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
    case "differs":
    case "merge":
      return <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />;
    default:
      return <Info className="h-4 w-4 text-sky-400" aria-hidden />;
  }
}

function ConnectLink({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext();
  return inRouter ? (
    <Link to="/settings/integrations" className="text-sky-400 hover:underline">
      {children}
    </Link>
  ) : (
    <a href="/settings/integrations" className="text-sky-400 hover:underline">
      {children}
    </a>
  );
}

/**
 * "Criar na Cloudflare" ao lado de uma lista de registros DNS. Só aparece funcional com a Cloudflare conectada
 * (Configurações → Integrações); sem ela, uma linha convida a conectar e a lista manual segue como sempre.
 * Fluxo: prévia (criar / já está certo / diferente) → a pessoa marca → aplica. Nada diferente é trocado sem marcar.
 */
export function CloudflareDnsAction({
  scope,
  autoOpen = false,
  onApplied,
}: {
  scope: CloudflareDnsScope;
  /** Abre a prévia sozinha (logo depois de cadastrar o domínio). */
  autoOpen?: boolean;
  /** Avisa quem usa o componente depois de aplicar (para conferir o DNS de novo). */
  onApplied?: () => void;
}) {
  const { t } = useI18n();
  const scopeKey = JSON.stringify(scope);
  const stableScope = useMemo(() => JSON.parse(scopeKey) as CloudflareDnsScope, [scopeKey]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "preview" | "applying" | "done">("idle");
  const [plan, setPlan] = useState<CloudflarePlanResponse | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CloudflareApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<CloudflareStatus>("/api/integrations/cloudflare")
      .then((s) => alive && setConnected(s?.connected === true))
      .catch(() => alive && setConnected(null));
    return () => {
      alive = false;
    };
  }, []);

  // Outro domínio digitado: a prévia antiga não vale mais.
  useEffect(() => {
    setPhase("idle");
    setPlan(null);
    setResult(null);
    setError(null);
  }, [scopeKey]);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<CloudflarePlanResponse>("/api/integrations/cloudflare/dns/plan", {
        method: "POST",
        body: JSON.stringify({ scope: stableScope }),
      });
      setPlan(res);
      setMarked(new Set(res.items.filter((i) => i.defaultSelected).map((i) => i.id)));
      setPhase("preview");
    } catch (err) {
      setError(apiErrorText(err, "cloudflare.action.error"));
      setPhase("idle");
    }
  }, [stableScope]);

  useEffect(() => {
    if (autoOpen && connected === true && phase === "idle" && plan === null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, connected]);

  async function apply() {
    setPhase("applying");
    setError(null);
    try {
      const res = await apiFetch<CloudflareApplyResponse>("/api/integrations/cloudflare/dns/apply", {
        method: "POST",
        body: JSON.stringify({ scope: stableScope, items: [...marked] }),
      });
      setResult(res);
      setPhase("done");
      onApplied?.();
    } catch (err) {
      setError(apiErrorText(err, "cloudflare.action.applyError"));
      setPhase("preview");
    }
  }

  function toggle(id: string, on: boolean) {
    setMarked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  if (connected === null) return null;
  if (!connected) {
    return (
      <p data-testid="cloudflare-hint" className="text-xs text-muted-foreground">
        {t("cloudflare.action.hint")} <ConnectLink>{t("cloudflare.action.connectLink")}</ConnectLink>
      </p>
    );
  }

  const items = plan?.items ?? [];
  const actionable = items.filter((i) => i.selectable);
  const allNoZone = items.length > 0 && items.every((i) => i.status === "no_zone");
  const nothingToDo = phase === "preview" && items.length > 0 && !allNoZone && actionable.length === 0 && items.every((i) => i.status === "ok");

  return (
    <div data-testid="cloudflare-action" className="flex flex-col gap-2">
      {phase === "idle" && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => void load()}>
          <CloudCog className="h-4 w-4" /> {t("cloudflare.action.button")}
        </Button>
      )}
      {phase === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("cloudflare.action.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {(phase === "preview" || phase === "applying") && plan && (
        <div data-testid="cloudflare-preview" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-sm">
          <p className="font-medium">{t("cloudflare.action.previewTitle")}</p>
          {allNoZone ? (
            <p role="note" className="flex items-start gap-2 text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {t("cloudflare.action.noZone")}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t("cloudflare.action.previewNote")}</p>
              {plan.noZoneCount > 0 && (
                <p role="note" className="text-xs text-amber-400">
                  {t("cloudflare.action.noZoneSome", { count: plan.noZoneCount })}
                </p>
              )}
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <PreviewRow key={item.id} item={item} marked={marked.has(item.id)} disabled={phase === "applying"} onToggle={toggle} />
                ))}
              </ul>
              {nothingToDo && <p className="text-emerald-400">{t("cloudflare.action.nothing")}</p>}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {actionable.length > 0 && (
              <Button size="sm" disabled={marked.size === 0 || phase === "applying"} onClick={() => void apply()}>
                {phase === "applying" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudCog className="h-4 w-4" />}{" "}
                {t("cloudflare.action.apply", { count: marked.size })}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={phase === "applying"} onClick={() => setPhase("idle")}>
              {t("cloudflare.action.close")}
            </Button>
          </div>
        </div>
      )}

      {phase === "done" && result && (
        <div data-testid="cloudflare-result" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-sm">
          <p className="font-medium">{t("cloudflare.result.title")}</p>
          <p>
            {t("cloudflare.result.summary", { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed })}
          </p>
          <ul className="flex flex-col gap-1 text-xs">
            {result.results.map((r) => (
              <li key={r.id} className={r.outcome === "failed" ? "text-red-400" : "text-muted-foreground"}>
                <strong>{t(OUTCOME_KEY[r.outcome])}</strong> {r.type} <code className="break-all">{r.name}</code>
                {r.outcome === "failed" && r.message ? `: ${r.message}` : ""}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("cloudflare.result.propagation")}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t("cloudflare.action.recheck")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPhase("idle")}>
              {t("cloudflare.action.close")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewRow({
  item,
  marked,
  disabled,
  onToggle,
}: {
  item: CloudflarePlanItem;
  marked: boolean;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  const { t } = useI18n();
  const reason = item.reason ? REASON_KEY[item.reason] : item.status === "merge" ? ("cloudflare.reason.merge" as Key) : undefined;
  return (
    <li data-testid={`cloudflare-item-${item.id}`} data-status={item.status} className="flex items-start gap-2 rounded-md border bg-background/40 p-2">
      {item.selectable ? (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={marked}
          disabled={disabled}
          aria-label={t("cloudflare.action.markItem", { type: item.type, name: item.name })}
          onChange={(e) => onToggle(item.id, e.target.checked)}
        />
      ) : (
        <span className="mt-0.5">
          <StatusIcon status={item.status} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[item.status]}>{t(STATUS_KEY[item.status])}</Badge>
          <span className="font-mono text-xs">{item.type}</span>
          <code className="break-all text-xs">{item.name}</code>
          {item.optional && <span className="text-xs text-muted-foreground">({t("cloudflare.item.optional")})</span>}
        </div>
        {item.current.length > 0 && item.status !== "ok" && (
          <p className="break-all text-xs text-muted-foreground">{t("cloudflare.item.current", { value: item.current.join(" | ") })}</p>
        )}
        {item.status !== "ok" && item.status !== "conflict" && item.status !== "no_zone" && (
          <p className="break-all text-xs">{t("cloudflare.item.proposed", { value: item.proposed })}</p>
        )}
        {reason && <p className="text-xs text-muted-foreground">{t(reason)}</p>}
        {item.ours && item.status === "differs" && <p className="text-xs text-muted-foreground">{t("cloudflare.item.ours")}</p>}
      </div>
    </li>
  );
}
