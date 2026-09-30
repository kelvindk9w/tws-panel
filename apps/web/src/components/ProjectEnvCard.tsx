import { useEffect, useState } from "react";
import type { Project } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CheckCircle2, Info, Loader2, Plus, Trash2, Variable } from "lucide-react";

interface EnvVar {
  key: string;
  value: string;
}

/**
 * Seção Variáveis: variáveis de ambiente do projeto (DATABASE_URL, chaves de
 * API…). Guardadas cifradas no servidor; valem a partir do próximo deploy.
 * Valores escondidos por padrão (olho para mostrar).
 */
export function ProjectEnvCard({ project }: { project: Project }) {
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ vars: EnvVar[] }>(`/api/projects/${project.id}/env`)
      .then((r) => setVars(r.vars))
      .catch((err: unknown) => {
        setVars([]);
        setError(err instanceof ApiRequestError ? err.message : "Não foi possível carregar as variáveis.");
      });
  }, [project.id]);

  function update(i: number, patch: Partial<EnvVar>) {
    setSaved(false);
    setVars((prev) => (prev ?? []).map((v, j) => (j === i ? { ...v, ...patch } : v)));
  }

  async function save() {
    if (!vars) return;
    setBusy(true);
    setError(null);
    try {
      const clean = vars.filter((v) => v.key.trim() !== "");
      const res = await apiFetch<{ vars: EnvVar[] }>(`/api/projects/${project.id}/env`, {
        method: "PUT",
        body: JSON.stringify({ vars: clean }),
      });
      setVars(res.vars);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }

  const staticSite = project.detection?.type === "static" || project.detection?.type === "static-node";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Variable className="h-4 w-4" /> Variáveis de ambiente
        </CardTitle>
        <CardDescription>
          Configurações e segredos que o app lê ao rodar (ex.: DATABASE_URL, API_KEY). Ficam cifradas no servidor e nunca
          aparecem nos logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {staticSite && (
          <p data-testid="env-static-note" className="flex items-start gap-2 text-sm text-amber-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Este projeto é um site estático: não há servidor rodando para ler variáveis. Elas valem para projetos com
            Dockerfile ou docker-compose.
          </p>
        )}
        {vars === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {vars.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma variável ainda.</p>}
            <ul className="flex flex-col gap-2">
              {vars.map((v, i) => (
                <li key={i} className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={v.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                    placeholder="NOME_DA_VARIAVEL"
                    className="font-mono sm:w-64"
                    aria-label={`Nome da variável ${i + 1}`}
                  />
                  <div className="flex flex-1 gap-2">
                    <PasswordInput
                      value={v.value}
                      onChange={(e) => update(i, { value: e.target.value })}
                      placeholder="valor"
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      containerClassName="flex-1"
                      aria-label={`Valor da variável ${i + 1}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remover ${v.key || "variável"}`}
                      onClick={() => {
                        setSaved(false);
                        setVars((prev) => (prev ?? []).filter((_, j) => j !== i));
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSaved(false);
                  setVars((prev) => [...(prev ?? []), { key: "", value: "" }]);
                }}
              >
                <Plus className="h-4 w-4" /> Adicionar variável
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar variáveis
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Salvas. Valem a partir do próximo deploy.
                </span>
              )}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
