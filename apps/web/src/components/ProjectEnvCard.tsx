import { useEffect, useRef, useState } from "react";
import type { Project } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { parseDotenv } from "@/lib/dotenv";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CheckCircle2, FileUp, Info, Loader2, Plus, Trash2, Variable } from "lucide-react";

interface EnvVar {
  key: string;
  value: string;
}

/** Linha do formulário; `suggested` = veio da lista do compose, ainda não salva. */
interface EnvRow extends EnvVar {
  suggested?: boolean;
}

interface ComposeVariable {
  name: string;
  required: boolean;
  defaultValue: string | null;
}

/** Um .env de verdade tem poucos KB; acima disso não é o arquivo certo. */
const MAX_ENV_FILE = 256 * 1024;

/**
 * Linhas da tela: as salvas e, em seguida, cada variável do compose que ainda
 * não está na lista (obrigatórias primeiro) — prontas para receber o valor.
 */
function buildRows(saved: EnvVar[], compose: ComposeVariable[] | null): EnvRow[] {
  const listed = new Set(saved.map((v) => v.key));
  const pending = (compose ?? []).filter((v) => !listed.has(v.name));
  return [
    ...saved,
    ...[...pending.filter((v) => v.required), ...pending.filter((v) => !v.required)].map((v) => ({
      key: v.name,
      value: "",
      suggested: true,
    })),
  ];
}

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/**
 * Seção Variáveis: variáveis de ambiente do projeto (DATABASE_URL, chaves de
 * API…). Guardadas cifradas no servidor; valem a partir do próximo deploy.
 * Valores escondidos por padrão (olho para mostrar). Dá para importar um
 * arquivo .env: ele é lido no navegador e só entra na lista — nada é gravado
 * antes de "Salvar variáveis".
 */
export function ProjectEnvCard({ project }: { project: Project }) {
  const [vars, setVars] = useState<EnvRow[] | null>(null);
  // O que o compose do projeto interpola (null = não é compose)
  const [composeVars, setComposeVars] = useState<ComposeVariable[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch<{ vars: EnvVar[]; compose?: { variables: ComposeVariable[] } | null }>(`/api/projects/${project.id}/env`)
      .then((r) => {
        const compose = r.compose?.variables ?? null;
        setComposeVars(compose);
        setVars(buildRows(r.vars, compose));
      })
      .catch((err: unknown) => {
        setVars([]);
        setError(err instanceof ApiRequestError ? err.message : "Não foi possível carregar as variáveis.");
      });
  }, [project.id]);

  function update(i: number, patch: Partial<EnvRow>) {
    setSaved(false);
    setVars((prev) => (prev ?? []).map((v, j) => (j === i ? { ...v, ...patch } : v)));
  }

  async function save() {
    if (!vars) return;
    setBusy(true);
    setError(null);
    try {
      // sugerida pelo compose e deixada vazia: não salva (vale o padrão do compose)
      const clean = vars
        .filter((v) => v.key.trim() !== "" && !(v.suggested && v.value === ""))
        .map(({ key, value }) => ({ key, value }));
      const res = await apiFetch<{ vars: EnvVar[] }>(`/api/projects/${project.id}/env`, {
        method: "PUT",
        body: JSON.stringify({ vars: clean }),
      });
      setVars(buildRows(res.vars, composeVars));
      setSaved(true);
      setImported(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setError(null);
    setImported(null);
    if (file.size > MAX_ENV_FILE) {
      setError(`O arquivo ${file.name} é grande demais para um .env (máximo 256 KB).`);
      return;
    }
    const { vars: read, skipped } = parseDotenv(await file.text());
    if (read.length === 0) {
      setError(`Nenhuma variável encontrada em ${file.name} (esperado: NOME=valor, uma por linha).`);
      return;
    }
    const current = vars ?? [];
    const byKey = new Map(read.map((v) => [v.key, v.value]));
    const existing = new Set(current.map((v) => v.key.trim()));
    const updated = read.filter((v) => existing.has(v.key)).length;
    const added = read.filter((v) => !existing.has(v.key));
    setVars([
      ...current.map((v) => (byKey.has(v.key.trim()) ? { key: v.key, value: byKey.get(v.key.trim())! } : v)),
      ...added,
    ]);
    setSaved(false);
    setImported(
      `${plural(read.length, "variável lida", "variáveis lidas")} de ${file.name}: ` +
        `${plural(updated, "atualizada", "atualizadas")}, ${plural(added.length, "nova", "novas")}.` +
        (skipped.length > 0
          ? ` ${skipped.length === 1 ? "Linha" : "Linhas"} ${skipped.join(", ")} ignorada${skipped.length === 1 ? "" : "s"} (não ${skipped.length === 1 ? "é" : "são"} NOME=valor).`
          : "") +
        " Nada foi gravado ainda: revise e clique em Salvar variáveis.",
    );
  }

  const staticSite = project.detection?.type === "static" || project.detection?.type === "static-node";
  const composeByName = new Map((composeVars ?? []).map((v) => [v.name, v]));
  const defined = new Set((vars ?? []).filter((v) => v.value !== "").map((v) => v.key.trim()));
  const missing = (composeVars ?? []).filter((v) => v.required && !defined.has(v.name));

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
        {composeVars && composeVars.length > 0 && (
          <p data-testid="compose-vars" className="rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
            O compose deste projeto usa {plural(composeVars.length, "variável", "variáveis")} — todas estão na lista abaixo
            para preencher. Sugerida que ficar vazia não é salva (vale o padrão do compose).
            {missing.length > 0 ? (
              <>
                {" "}
                <strong className="text-red-400">{missing.length} obrigatória(s) ainda sem valor</strong>: o deploy falha
                sem elas.
              </>
            ) : (
              " Todas as obrigatórias têm valor."
            )}
          </p>
        )}
        {vars === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {vars.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma variável ainda.</p>}
            <ul className="flex flex-col gap-2">
              {vars.map((v, i) => {
                const cv = composeByName.get(v.key.trim());
                const placeholder = !cv
                  ? "valor"
                  : cv.required
                    ? "obrigatória"
                    : cv.defaultValue !== null
                      ? `padrão: ${cv.defaultValue || "vazio"}`
                      : "opcional";
                return (
                  <li key={i} data-testid={v.key ? `env-row-${v.key.trim()}` : undefined} className="flex flex-col gap-1">
                    <div className="flex flex-col gap-2 sm:flex-row">
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
                          placeholder={placeholder}
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
                    </div>
                    {cv && (
                      <span
                        className={cn(
                          "text-xs",
                          cv.required && v.value === "" ? "text-red-300" : "text-muted-foreground",
                        )}
                      >
                        {cv.required
                          ? "obrigatória no compose"
                          : cv.defaultValue !== null
                            ? `opcional no compose · padrão: ${cv.defaultValue || "vazio"}`
                            : "opcional no compose"}
                      </span>
                    )}
                  </li>
                );
              })}
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
              <Button variant="outline" onClick={() => fileInput.current?.click()}>
                <FileUp className="h-4 w-4" /> Importar arquivo .env
              </Button>
              <input
                ref={fileInput}
                type="file"
                data-testid="env-file-input"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFile(file);
                }}
              />
              <Button onClick={() => void save()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar variáveis
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Salvas. Valem a partir do próximo deploy.
                </span>
              )}
            </div>
            {imported && (
              <p data-testid="env-import-result" className="flex items-start gap-2 text-sm text-amber-300">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {imported}
              </p>
            )}
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
