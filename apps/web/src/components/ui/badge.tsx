import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-4 tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-red-500/25 bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/10",
        outline: "text-muted-foreground",
        success:
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/10",
        warning:
          "border-amber-500/25 bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/10",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
