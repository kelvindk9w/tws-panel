import { Link, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { QueueSection } from "@/components/envios/QueueSection";
import { HistorySection } from "@/components/envios/HistorySection";
import { VolumeSection } from "@/components/envios/VolumeSection";
import { ReputationSection } from "@/components/envios/ReputationSection";
import { ScoreSection } from "@/components/envios/ScoreSection";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "fila", label: "Fila agora" },
  { id: "historico", label: "Histórico" },
  { id: "volume", label: "Volume" },
  { id: "reputacao", label: "Reputação" },
  { id: "nota", label: "Nota" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Página Envios (E-mail → Envios): o que o servidor de e-mail está fazendo.
 * A aba fica no endereço (?aba=historico), para dar para mandar o link.
 */
export function MailEnviosPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("aba");
  const tab: TabId = TABS.some((t) => t.id === asked) ? (asked as TabId) : "fila";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link to="/mail" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> E-mail
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Envios</h1>
        <p className="text-sm text-muted-foreground">
          O que o servidor de e-mail está fazendo: mensagens na fila, o resultado de cada entrega, o volume e a reputação.
        </p>
      </div>

      <div role="tablist" aria-label="Seções de Envios" className="flex flex-wrap gap-1 border-b pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setParams(t.id === "fila" ? {} : { aba: t.id }, { replace: true })}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === t.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "fila" && <QueueSection />}
        {tab === "historico" && <HistorySection />}
        {tab === "volume" && <VolumeSection />}
        {tab === "reputacao" && <ReputationSection />}
        {tab === "nota" && <ScoreSection />}
      </div>
    </div>
  );
}
