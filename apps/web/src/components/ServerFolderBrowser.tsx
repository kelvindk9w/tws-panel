import { useEffect, useState } from "react";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ArrowUp, FileCode2, Folder, Loader2, X } from "lucide-react";

interface DirListing {
  root: string;
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string; hasIndexHtml: boolean }>;
}

/**
 * Janela de pastas do SERVIDOR, presa à pasta de projetos — a única do
 * computador que o painel enxerga de dentro do container.
 */
export function ServerFolderBrowser({ onChoose, onClose }: { onChoose: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  function open(path?: string) {
    setError(null);
    apiFetch<DirListing>(path ? `/api/fs/dirs?path=${encodeURIComponent(path)}` : "/api/fs/dirs")
      .then(setListing)
      .catch((err: unknown) => setError(err instanceof ApiRequestError ? err.message : "Não foi possível abrir a pasta."));
  }

  useEffect(() => open(), []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col gap-3 rounded-lg border bg-card p-5 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Escolher pasta no servidor</h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {listing && (
          <p className="text-xs text-muted-foreground">
            Só aparecem pastas dentro de <code className="font-mono text-foreground">{listing.root}</code> — a pasta de
            projetos deste servidor. Para colocar código aqui, use "Enviar do meu computador" ou clone o repositório
            nela pelo terminal.
          </p>
        )}
        <div className="flex items-center gap-2 rounded bg-black/40 px-2 py-1.5">
          <code data-testid="folder-browser-path" className="flex-1 break-all font-mono text-xs">
            {listing?.path ?? "…"}
          </code>
          {listing?.parent && (
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => open(listing.parent!)}>
              <ArrowUp className="h-3.5 w-3.5" /> Voltar
            </Button>
          )}
        </div>
        <div className="min-h-24 overflow-y-auto">
          {!listing && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {listing && listing.dirs.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma subpasta aqui.</p>
          )}
          <ul className="flex flex-col">
            {listing?.dirs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => open(d.path)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Folder className="h-4 w-4 text-sky-400" /> {d.name}
                  {d.hasIndexHtml && (
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                      <FileCode2 className="h-3 w-3" /> index.html
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" disabled={!listing || listing.path === listing.root} onClick={() => listing && onChoose(listing.path)}>
            Usar esta pasta
          </Button>
        </div>
      </div>
    </div>
  );
}
