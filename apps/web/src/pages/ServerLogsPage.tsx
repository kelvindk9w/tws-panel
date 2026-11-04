import { ServerLogsPanel } from "@/components/serverlogs/ServerLogsPanel";

/** Página "Logs do servidor" (somente leitura). */
export function ServerLogsPage() {
  return (
    <div className="flex flex-col gap-6">
      <ServerLogsPanel />
    </div>
  );
}
