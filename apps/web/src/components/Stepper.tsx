import { Check, Lock } from "lucide-react";
import type { SetupStepInfo } from "@paas/core";
import { cn } from "@/lib/utils";

interface StepperProps {
  steps: SetupStepInfo[];
  currentStep: number;
  /** Maior índice navegável (passos já concluídos/alcançados). */
  maxSelectable?: number;
  /** Clique num passo já alcançado (navegação de volta sem perder estado). */
  onSelect?: (index: number) => void;
}

export function Stepper({ steps, currentStep, maxSelectable, onSelect }: StepperProps) {
  const selectable = maxSelectable ?? currentStep;
  return (
    <ol className="flex w-full items-center gap-2">
      {steps.map((step, index) => {
        const done = index < currentStep;
        const active = index === currentStep;
        const clickable = !active && index <= selectable && onSelect !== undefined;
        const marker = (
          <span
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular transition-all duration-300",
              done && "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
              active &&
                "border-primary bg-primary text-primary-foreground shadow-[0_0_0_4px_rgba(255,255,255,0.08)]",
              !done && !active && "border-border text-muted-foreground",
              clickable && "cursor-pointer hover:border-emerald-400 hover:text-emerald-300",
            )}
          >
            {done ? <Check className="h-4 w-4" /> : !step.available ? <Lock className="h-3.5 w-3.5" /> : index + 1}
          </span>
        );
        const title = (
          <span
            className={cn(
              "hidden text-sm tracking-tight transition-colors duration-300 md:block",
              active ? "font-medium text-foreground" : "text-muted-foreground",
              clickable && "hover:text-foreground",
            )}
          >
            {step.title}
          </span>
        );
        return (
          <li key={step.key} className="flex flex-1 items-center gap-2 last:flex-none">
            {clickable ? (
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-label={`Voltar para ${step.title}`}
                className="flex items-center gap-2"
              >
                {marker}
                {title}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                {marker}
                {title}
              </div>
            )}
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "h-px flex-1 transition-colors duration-500",
                  done ? "bg-emerald-500/40" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
