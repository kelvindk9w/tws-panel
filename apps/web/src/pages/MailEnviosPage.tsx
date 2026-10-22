import { Link, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { QueueSection } from "@/components/envios/QueueSection";
import { HistorySection } from "@/components/envios/HistorySection";
import { SendLogSection } from "@/components/envios/SendLogSection";
import { SendPrivacyCard } from "@/components/envios/SendPrivacyCard";
import { VolumeSection } from "@/components/envios/VolumeSection";
import { ReputationSection } from "@/components/envios/ReputationSection";
import { ScoreSection } from "@/components/envios/ScoreSection";
import { cn } from "@/lib/utils";
import { useI18n, type Key } from "@/i18n";

const TABS = [
  { id: "fila", label: "envios.page.tab.queue" },
  { id: "historico", label: "envios.page.tab.history" },
  { id: "saidas", label: "envios.page.tab.sends" },
  { id: "volume", label: "envios.page.tab.volume" },
  { id: "reputacao", label: "envios.page.tab.reputation" },
  { id: "nota", label: "envios.page.tab.score" },
  { id: "privacidade", label: "envios.page.tab.privacy" },
] as const satisfies readonly { id: string; label: Key }[];

type TabId = (typeof TABS)[number]["id"];

/**
 * Página Envios (E-mail → Envios): o que o servidor de e-mail está fazendo.
 * A aba fica no endereço (?aba=historico), para dar para mandar o link.
 */
export function MailEnviosPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const asked = params.get("aba");
  const tab: TabId = TABS.some((x) => x.id === asked) ? (asked as TabId) : "fila";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link to="/mail" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> {t("envios.page.back")}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{t("envios.page.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("envios.page.subtitle")}
        </p>
      </div>

      <div role="tablist" aria-label={t("envios.page.tablist")} className="flex flex-wrap gap-1 border-b pb-2">
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`panel-${x.id}`}
            onClick={() => setParams(x.id === "fila" ? {} : { aba: x.id }, { replace: true })}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === x.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t(x.label)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "fila" && <QueueSection />}
        {tab === "historico" && <HistorySection />}
        {tab === "saidas" && <SendLogSection />}
        {tab === "volume" && <VolumeSection />}
        {tab === "reputacao" && <ReputationSection />}
        {tab === "nota" && <ScoreSection />}
        {tab === "privacidade" && <SendPrivacyCard />}
      </div>
    </div>
  );
}
