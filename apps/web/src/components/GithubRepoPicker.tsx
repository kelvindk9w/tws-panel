import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Github, Loader2, Lock } from "lucide-react";

export interface GithubRepo {
  fullName: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

/**
 * "Escolher dos meus repositórios": com a conta do GitHub conectada
 * (Configurações → Integrações), lista os repositórios dela; sem conexão,
 * convida a conectar. Colar a URL continua funcionando igual.
 */
export function GithubRepoPicker({ onPick }: { onPick: (repo: GithubRepo) => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ connected: boolean }>("/api/integrations/github")
      .then((s) => setConnected(s?.connected === true))
      .catch(() => setConnected(null));
  }, []);

  function openList() {
    setOpen(true);
    if (repos) return;
    apiFetch<{ repos: GithubRepo[] }>("/api/integrations/github/repos")
      .then((r) => setRepos(r.repos))
      .catch((err: unknown) => setError(err instanceof ApiRequestError ? err.message : "Não foi possível listar os repositórios."));
  }

  const filtered = useMemo(
    () => (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase())),
    [repos, query],
  );

  if (connected === null) return null;
  if (!connected) {
    return (
      <p className="text-xs text-muted-foreground">
        Prefere escolher numa lista?{" "}
        <Link to="/settings/integrations" className="text-sky-400 hover:underline">
          Conectar minha conta do GitHub
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {!open && (
        <Button type="button" variant="outline" className="self-start" onClick={openList}>
          <Github className="h-4 w-4" /> Escolher dos meus repositórios
        </Button>
      )}
      {open && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar repositório…" autoFocus />
          {!repos && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {filtered.map((r) => (
              <li key={r.fullName}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(r);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="flex-1">
                    <span className="font-mono">{r.fullName}</span>
                    {r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}
                  </span>
                  {r.private && (
                    <span className="flex items-center gap-1 text-xs text-amber-400">
                      <Lock className="h-3 w-3" /> privado
                    </span>
                  )}
                </button>
              </li>
            ))}
            {repos && filtered.length === 0 && <li className="px-2 text-sm text-muted-foreground">Nenhum repositório encontrado.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
