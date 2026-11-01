import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Bloco cinza pulsando no lugar de um dado que ainda não chegou. Dê a ele o tamanho do conteúdo
 * final (altura/largura) para a tela não "pular" quando o dado aparecer.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
