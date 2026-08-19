import { Check, Lock } from "lucide-react";
import type { SetupStepInfo } from "@paas/core";
import { cn } from "@/lib/utils";

interface StepperProps {
  steps: SetupStepInfo[];
  currentStep: number;
}

export function Stepper({ steps, currentStep }: StepperProps) {
  return (
    <ol className="flex w-full items-center gap-2">
      {steps.map((step, index) => {
        const done = index < currentStep;
        const active = index === currentStep;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-2 last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                  done && "border-emerald-500 bg-emerald-500/20 text-emerald-400",
                  active && "border-primary bg-primary text-primary-foreground",
                  !done && !active && "border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="h-4 w-4" /> : !step.available ? <Lock className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "hidden text-sm md:block",
                  active ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {step.title}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div className={cn("h-px flex-1", done ? "bg-emerald-500/50" : "bg-border")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
