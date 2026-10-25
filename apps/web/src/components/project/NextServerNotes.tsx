import type { DetectResult } from "@paas/core";
import { AlertTriangle, CheckCircle2, ExternalLink, Info } from "lucide-react";
import { useI18n, type Key } from "@/i18n";
import { nextjsGuideUrl } from "@/lib/links";

const SOURCE_KEY = {
  engines: "projects.nextServer.source.engines",
  nvmrc: "projects.nextServer.source.nvmrc",
  "node-version": "projects.nextServer.source.node-version",
  default: "projects.nextServer.source.default",
} as const satisfies Record<NonNullable<DetectResult["nodeServer"]>["nodeSource"], Key>;

/**
 * O que o painel faz com um projeto Next.js com servidor (type node-server):
 * Node, gerenciador, lockfile, standalone, e as duas coisas que mais pegam
 * quem chega do Vercel — NEXT_PUBLIC_ é público e o build pode faltar memória.
 * Usado no assistente de criação e na visão geral do projeto.
 */
export function NextServerNotes({ detection, port }: { detection: DetectResult; port: number | null }) {
  const { t, locale } = useI18n();
  const info = detection.nodeServer;
  return (
    <div data-testid="next-server-notes" className="flex flex-col gap-3 rounded-lg border bg-secondary/20 p-3 text-sm">
      <p className="text-muted-foreground">{t("projects.nextServer.intro")}</p>
      {info && (
        <ul className="flex flex-col gap-1.5 text-muted-foreground">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span data-testid="next-node">
              {t("projects.nextServer.node", { major: info.nodeMajor, source: t(SOURCE_KEY[info.nodeSource]) })}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span data-testid="next-manager">{t("projects.nextServer.manager", { manager: detection.packageManager ?? "npm" })}</span>
          </li>
          <li className="flex items-start gap-2" data-testid="next-lockfile">
            {info.lockfile ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            )}
            {info.lockfile ? t("projects.nextServer.lockfileOn") : t("projects.nextServer.lockfileOff")}
          </li>
          <li className="flex items-start gap-2" data-testid="next-standalone">
            {info.standalone ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
            )}
            {info.standalone ? t("projects.nextServer.standalone") : t("projects.nextServer.noStandalone")}
          </li>
        </ul>
      )}
      {port !== null && (
        <p data-testid="next-port" className="font-mono text-xs">
          {t("projects.nextServer.port")}: {port}
        </p>
      )}
      <div data-testid="next-public-note" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
        <p className="mb-1 font-medium text-amber-400">{t("projects.nextServer.publicTitle")}</p>
        <p className="text-muted-foreground">{t("projects.nextServer.publicBody")}</p>
      </div>
      <div data-testid="next-memory-note" className="rounded-md border p-3">
        <p className="mb-1 font-medium">{t("projects.nextServer.memoryTitle")}</p>
        <p className="text-muted-foreground">{t("projects.nextServer.memoryBody")}</p>
      </div>
      <a
        href={nextjsGuideUrl(locale)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
      >
        {t("projects.nextServer.guide")} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
