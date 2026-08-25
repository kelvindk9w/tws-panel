/**
 * IndexGauge — anel de progresso do índice de segurança (SVG puro).
 *
 * Arco animado via stroke-dashoffset (CSS transition — nada de JS por frame),
 * cor por faixa de score (emerald ≥ 75, amber ≥ 50, red abaixo) com glow sutil
 * na mesma cor. Usado no wizard (antes/depois do hardening) e na tela de
 * conclusão do setup.
 */
interface IndexGaugeProps {
  value: number | null;
  source: string;
  /** md (112px) = comparação antes/depois; sm (96px) = score final do setup. */
  size?: "sm" | "md";
}

export function IndexGauge({ value, source, size = "md" }: IndexGaugeProps) {
  const v = value ?? 0;
  const hex = v >= 75 ? "#34d399" : v >= 50 ? "#fbbf24" : "#f87171";
  const color = v >= 75 ? "text-emerald-400" : v >= 50 ? "text-amber-400" : "text-red-400";
  const R = 44;
  const CIRC = 2 * Math.PI * R;
  const filled = Math.min(Math.max(v, 0), 100) / 100;
  const box = size === "sm" ? "h-24 w-24" : "h-28 w-28";
  const number = size === "sm" ? "text-2xl" : "text-3xl";
  return (
    <div
      className={`relative ${box}`}
      role="img"
      aria-label={`Índice de segurança: ${value ?? "—"} de 100`}
    >
      <svg
        viewBox="0 0 112 112"
        className="h-full w-full -rotate-90"
        style={{ filter: `drop-shadow(0 0 10px ${hex}33)` }}
      >
        <circle cx="56" cy="56" r={R} fill="none" strokeWidth="6" className="stroke-white/[0.07]" />
        <circle
          cx="56"
          cy="56"
          r={R}
          fill="none"
          stroke={hex}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - filled)}
          style={{ transition: "stroke-dashoffset 700ms cubic-bezier(0.16, 1, 0.3, 1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`${number} font-bold tracking-tight tabular ${color}`}>{value ?? "—"}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {source === "lynis" ? "Lynis Index" : "Índice interno"}
        </span>
      </div>
    </div>
  );
}
