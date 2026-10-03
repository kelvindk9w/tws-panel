import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  PROJECT_EMAIL_VALUE_KEYS,
  missingComposeVariables,
  type ComposeVariable,
  type Project,
  type ProjectEmailValueKey,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { parseDotenv } from "@/lib/dotenv";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  FileUp,
  Info,
  LayoutList,
  Loader2,
  Mail,
  Plus,
  Rows3,
  Search,
  Trash2,
  Variable,
  X,
} from "lucide-react";

interface EnvVar {
  key: string;
  value: string;
}

/** Linha do formulário; `suggested` = veio da lista do compose, ainda não salva. */
interface EnvRow extends EnvVar {
  id: number;
  suggested?: boolean;
}

/** Um .env de verdade tem poucos KB; acima disso não é o arquivo certo. */
const MAX_ENV_FILE = 256 * 1024;

let nextRowId = 1;
const row = (v: EnvVar, suggested = false): EnvRow => ({ id: nextRowId++, ...v, ...(suggested ? { suggested } : {}) });

/**
 * Linhas da tela: as salvas e, em seguida, cada variável do compose que ainda
 * não está na lista (obrigatórias primeiro) — prontas para receber o valor.
 */
function buildRows(saved: EnvVar[], compose: ComposeVariable[] | null): EnvRow[] {
  const listed = new Set(saved.map((v) => v.key));
  const pending = (compose ?? []).filter((v) => !listed.has(v.name));
  return [
    ...saved.map((v) => row(v)),
    ...[...pending.filter((v) => v.required), ...pending.filter((v) => !v.required)].map((v) =>
      row({ key: v.name, value: "" }, true),
    ),
  ];
}

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/** Variáveis citadas num padrão (`${MAIL_FROM:?…}` → MAIL_FROM). */
function namesIn(text: string): string[] {
  return [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
}

/** O que a linha significa para o compose (rótulo e placeholder). `linkedTo` = valor do e-mail ligado a ela. */
function describe(
  cv: ComposeVariable | undefined,
  provided: boolean,
  linkedTo?: string,
): { label: string; placeholder: string } | null {
  if (provided) {
    const from = linkedTo ? ` (← ${linkedTo})` : "";
    return {
      label: `fornecida pelo E-mail do projeto${from} — preencher aqui substitui`,
      placeholder: "fornecida pelo painel",
    };
  }
  if (!cv) return null;
  if (cv.required && cv.alternatives?.length) {
    const alt = cv.alternatives.join(" ou ");
    return { label: `obrigatória se ${alt} estiver vazia`, placeholder: `obrigatória se ${alt} estiver vazia` };
  }
  if (cv.required) return { label: "obrigatória no compose", placeholder: "obrigatória" };
  if (cv.defaultValue !== null && cv.defaultValue.includes("${")) {
    const from = namesIn(cv.defaultValue).join(" / ");
    return { label: `opcional no compose · se vazia, usa ${from}`, placeholder: `se vazia, usa ${from}` };
  }
  if (cv.defaultValue !== null) {
    const d = cv.defaultValue || "vazio";
    return { label: `opcional no compose · padrão: ${d}`, placeholder: `padrão: ${d}` };
  }
  return { label: "opcional no compose", placeholder: "opcional" };
}

type Filter = "all" | "missing" | "filled" | "panel";
type Density = "list" | "compact";

/** Densidade da lista guardada no navegador (só conforto; sem armazenamento, vale "Lista"). */
const DENSITY_KEY = "paas:env-density";

function readDensity(): Density {
  try {
    return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "list";
  } catch {
    return "list";
  }
}

function saveDensity(d: Density) {
  try {
    window.localStorage.setItem(DENSITY_KEY, d);
  } catch {
    // modo privado / armazenamento bloqueado: só não lembra da escolha
  }
}

/** Nome com cara de segredo: o valor nunca entra na pesquisa, mesmo à mostra. */
const SECRET_NAME = /PASS|SENHA|SECRET|TOKEN|KEY|CHAVE|PRIVATE|CREDENTIAL|AUTH|CERT/i;

/** Linha da lista: uma variável editável ou uma que o painel entrega (só o nome). */
type Line = { kind: "row"; row: EnvRow; index: number } | { kind: "panel"; name: string; source?: string };

const lineName = (l: Line) => (l.kind === "row" ? l.row.key.trim() : l.name);

/**
 * Seção Variáveis: variáveis de ambiente do projeto (DATABASE_URL, chaves de
 * API…). Guardadas cifradas no servidor; valem a partir do próximo deploy.
 * Valores escondidos por padrão: o olho mostra um, "Mostrar valores" mostra
 * todos, e valor visível pode ser copiado. Dá para importar um .env (lido no
 * navegador; nada é gravado antes de "Salvar variáveis") e apagar todas para
 * recomeçar. A lista rola dentro do cartão; os botões ficam no rodapé.
 *
 * No topo, pesquisa (nome, qualquer parte; valor só se estiver à mostra e o
 * nome não parecer segredo), filtros rápidos (Todas · Faltando · Preenchidas
 * · Do painel) e densidade (Lista / Compacta, guardada no navegador). Com a
 * pesquisa ativa, "Mostrar valores" vale só para as mostradas (revela menos)
 * e "Apagar todas"/"Salvar" continuam valendo para todas — a tela avisa.
 * O que o e-mail do projeto entrega (e o que está ligado a ele) aparece na
 * lista só com o nome.
 */
export function ProjectEnvCard({ project }: { project: Project }) {
  const [vars, setVars] = useState<EnvRow[] | null>(null);
  // O que o compose do projeto interpola (null = não é compose)
  const [composeVars, setComposeVars] = useState<ComposeVariable[] | null>(null);
  // Variáveis que o painel fornece sozinho (e-mail do projeto ativo)
  const [provided, setProvided] = useState<string[]>([]);
  // Variáveis do app ligadas a valores do e-mail (SMTP_SENHA → SMTP_PASS)
  const [links, setLinks] = useState<Record<string, ProjectEmailValueKey>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [density, setDensity] = useState<Density>(readDensity);
  // linhas mexidas com a pesquisa ativa: não somem enquanto a pessoa edita
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [savedCount, setSavedCount] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch<{
      vars: EnvVar[];
      compose?: { variables: ComposeVariable[] } | null;
      provided?: string[];
      links?: Record<string, ProjectEmailValueKey>;
    }>(`/api/projects/${project.id}/env`)
      .then((r) => {
        const compose = r.compose?.variables ?? null;
        setComposeVars(compose);
        setProvided(r.provided ?? []);
        setLinks(r.links ?? {});
        setSavedCount(r.vars.length);
        setVars(buildRows(r.vars, compose));
      })
      .catch((err: unknown) => {
        setVars([]);
        setError(err instanceof ApiRequestError ? err.message : "Não foi possível carregar as variáveis.");
      });
  }, [project.id]);

  function changed() {
    setNotice(null);
  }

  function search(text: string, next: Filter = filter) {
    setQuery(text);
    setFilter(next);
    setPinned(new Set());
  }

  function update(id: number, patch: Partial<EnvRow>) {
    changed();
    if (query.trim() !== "" || filter !== "all") setPinned((prev) => new Set(prev).add(id));
    setVars((prev) => (prev ?? []).map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }

  function setRowVisible(id: number, show: boolean) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (show) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function copy(r: EnvRow) {
    if (await copyText(r.value)) {
      setCopied(r.id);
      setTimeout(() => setCopied((c) => (c === r.id ? null : c)), 1500);
    }
  }

  async function put(list: EnvVar[]): Promise<EnvVar[]> {
    const res = await apiFetch<{ vars: EnvVar[] }>(`/api/projects/${project.id}/env`, {
      method: "PUT",
      body: JSON.stringify({ vars: list }),
    });
    setSavedCount(res.vars.length);
    setVars(buildRows(res.vars, composeVars));
    setVisible(new Set());
    setImported(null);
    return res.vars;
  }

  async function save() {
    if (!vars) return;
    setBusy(true);
    setError(null);
    try {
      // sugerida pelo compose e deixada vazia: não salva (vale o padrão do compose)
      await put(
        vars
          .filter((v) => v.key.trim() !== "" && !(v.suggested && v.value === ""))
          .map(({ key, value }) => ({ key, value })),
      );
      setNotice("Salvas. Valem a partir do próximo deploy.");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    setError(null);
    try {
      await put([]);
      setConfirmClear(false);
      setNotice("Variáveis apagadas. Importe o .env de novo ou preencha a lista.");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível apagar as variáveis.");
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
      ...current.map((v) =>
        byKey.has(v.key.trim()) ? { id: v.id, key: v.key, value: byKey.get(v.key.trim())! } : v,
      ),
      ...added.map((v) => row(v)),
    ]);
    changed();
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
  const providedSet = new Set(provided);
  const composeByName = new Map((composeVars ?? []).map((v) => [v.name, v]));
  const defined = new Set([
    ...(vars ?? []).filter((v) => v.value !== "").map((v) => v.key.trim()),
    ...provided,
  ]);
  const missing = missingComposeVariables(composeVars ?? [], defined);
  const missingSet = new Set(missing);
  // O que o e-mail entrega com o nome padrão, na ordem da tela do e-mail…
  const delivered = PROJECT_EMAIL_VALUE_KEYS.filter((k) => providedSet.has(k));
  // …e as variáveis do app ligadas a ele (SMTP_SENHA ← SMTP_PASS)
  const linked = provided.filter((n) => !(PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(n));
  // Fornecidas que não são linhas da lista entram nela só com o nome
  // (o valor — a senha, inclusive — nunca aparece aqui).
  const listedNames = new Set((vars ?? []).map((v) => v.key.trim()));
  const lines: Line[] = [
    ...(vars ?? []).map((row, index): Line => ({ kind: "row", row, index })),
    ...[...delivered, ...linked]
      .filter((name) => !listedNames.has(name))
      .map((name): Line => ({ kind: "panel", name, ...(links[name] ? { source: links[name] } : {}) })),
  ];

  const isMissing = (r: EnvRow) => {
    const name = r.key.trim();
    return r.value === "" && !providedSet.has(name) && missingSet.has(name);
  };
  const inFilter = (l: Line, f: Filter) => {
    if (f === "missing") return l.kind === "row" && isMissing(l.row);
    if (f === "filled") return l.kind === "row" && l.row.value !== "";
    if (f === "panel") return providedSet.has(lineName(l));
    return true;
  };
  const q = query.trim().toLowerCase();
  const inQuery = (l: Line) => {
    if (!q) return true;
    const name = lineName(l);
    if (name.toLowerCase().includes(q)) return true;
    if (l.kind === "panel") return (l.source ?? "").toLowerCase().includes(q);
    // valor: só o que já está à mostra, e nunca o de nome com cara de segredo
    return visible.has(l.row.id) && !SECRET_NAME.test(name) && l.row.value.toLowerCase().includes(q);
  };
  const filtering = q !== "" || filter !== "all";
  const shownLines = lines.filter(
    (l) =>
      (l.kind === "row" && (l.row.key.trim() === "" || pinned.has(l.row.id))) || (inFilter(l, filter) && inQuery(l)),
  );
  const shownRows = shownLines.flatMap((l) => (l.kind === "row" ? [l.row] : []));
  const shownIds = new Set(shownRows.map((r) => r.id));
  const hiddenSaved = (vars ?? []).filter((r) => !r.suggested && !shownIds.has(r.id)).length;
  const counts = {
    missing: lines.filter((l) => inFilter(l, "missing")).length,
    filled: lines.filter((l) => inFilter(l, "filled")).length,
    panel: lines.filter((l) => inFilter(l, "panel")).length,
  };
  // "Mostrar valores" vale para as mostradas: com a pesquisa ativa, revela menos
  const allVisible = shownRows.length > 0 && shownRows.every((v) => visible.has(v.id));
  const compact = density === "compact";

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Variable className="h-4 w-4" /> Variáveis de ambiente
        </CardTitle>
        <CardDescription>
          Configurações e segredos que o app lê ao rodar (ex.: DATABASE_URL, API_KEY). Ficam cifradas no servidor e nunca
          aparecem nos logs.
        </CardDescription>
        {staticSite && (
          <p data-testid="env-static-note" className="flex items-start gap-2 pt-2 text-sm text-amber-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Este projeto é um site estático: não há servidor rodando para ler variáveis. Elas valem para projetos com
            Dockerfile ou docker-compose.
          </p>
        )}
        {composeVars && composeVars.length > 0 && (
          <p data-testid="compose-vars" className="mt-2 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
            O compose deste projeto usa {plural(composeVars.length, "variável", "variáveis")} — todas estão na lista abaixo
            para preencher. Sugerida que ficar vazia não é salva (vale o padrão do compose).
            {missing.length > 0 ? (
              <>
                {" "}
                <strong className="text-red-400">{missing.length} obrigatória(s) ainda sem valor</strong>: o deploy não
                começa sem elas
                {/* poucas: os nomes aqui mesmo; muitas: o filtro Faltando mostra só elas */}
                {missing.length <= 5 ? (
                  ` (${missing.join(", ")}).`
                ) : (
                  <>
                    .{" "}
                    <button
                      type="button"
                      className="text-sky-400 underline"
                      onClick={() => search("", "missing")}
                    >
                      Ver as {missing.length} em Faltando
                    </button>
                  </>
                )}
              </>
            ) : (
              " Todas as obrigatórias têm valor."
            )}
          </p>
        )}
        {provided.length > 0 && (
          <div data-testid="env-provided" className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
            {delivered.length > 0 && (
              <p className="flex items-start gap-2 text-emerald-300">
                <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  O e-mail do projeto entrega estas variáveis no deploy: <span className="font-mono">{delivered.join(", ")}</span>.
                </span>
              </p>
            )}
            {linked.length > 0 && (
              <p className="mt-1 text-emerald-300 [overflow-wrap:anywhere]">
                Ligadas a ele:{" "}
                <span className="font-mono">
                  {linked.map((n) => (links[n] ? `${n} ← ${links[n]}` : n)).join(", ")}
                </span>
                .
              </p>
            )}
            <p className="mt-2 text-muted-foreground">
              Se o seu app usa outros nomes (ex.: SMTP_SENHA), ligue em{" "}
              <Link to={`/projects/${project.id}/email`} className="text-sky-400 underline">
                E-mail → Ligar às variáveis do projeto
              </Link>
              . Os valores não aparecem aqui (a senha, nunca). Preencher aqui uma variável com o mesmo nome substitui o
              valor do e-mail.
            </p>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-0 p-0">
        {vars === null ? (
          <Loader2 className="mx-6 mb-6 h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div data-testid="env-toolbar" className="flex flex-col gap-2 border-t px-6 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => search(e.target.value)}
                  placeholder="Pesquisar por nome ou valor"
                  aria-label="Pesquisar variáveis"
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-8 pr-9 [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="Apagar o texto da pesquisa"
                    onClick={() => search("")}
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div role="group" aria-label="Filtrar" className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["all", "Todas"],
                      ["missing", `Faltando (${counts.missing})`],
                      ["filled", `Preenchidas (${counts.filled})`],
                      ["panel", `Do painel (${counts.panel})`],
                    ] as const
                  ).map(([f, text]) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={filter === f}
                      onClick={() => search(query, f)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                        filter === f
                          ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
                          : "text-muted-foreground hover:text-foreground",
                        f === "missing" && counts.missing > 0 && filter !== f && "text-red-300",
                      )}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <div role="group" aria-label="Exibição" className="ml-auto flex rounded-md border p-0.5">
                  {(
                    [
                      ["list", "Lista", LayoutList],
                      ["compact", "Compacta", Rows3],
                    ] as const
                  ).map(([d, text, Icon]) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={density === d}
                      onClick={() => {
                        setDensity(d);
                        saveDensity(d);
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                        density === d ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" /> {text}
                    </button>
                  ))}
                </div>
              </div>
              <p data-testid="env-count" className="text-xs text-muted-foreground">
                {filtering
                  ? `${shownLines.length} de ${plural(lines.length, "variável", "variáveis")}`
                  : plural(lines.length, "variável", "variáveis")}
              </p>
              {filtering && (
                <p data-testid="env-filter-note" className="text-xs text-amber-300/90">
                  Com a pesquisa ativa, “Mostrar valores” vale só para as mostradas ({shownRows.length} de{" "}
                  {(vars ?? []).length}); “Apagar todas” e “Salvar variáveis” valem para todas.
                </p>
              )}
            </div>

            {/* a lista rola aqui dentro: a página não ganha uma barra enorme */}
            <div
              data-testid="env-list"
              data-density={density}
              className="max-h-[calc(100dvh-30rem)] min-h-[10rem] overflow-y-auto border-t px-6 py-3"
            >
              {lines.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma variável ainda.</p>}
              {lines.length > 0 && shownLines.length === 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  Nenhuma variável corresponde à pesquisa.
                  <Button variant="outline" size="sm" onClick={() => search("", "all")}>
                    Limpar pesquisa
                  </Button>
                </div>
              )}
              <ul className={cn("flex flex-col", compact ? "gap-1.5" : "gap-3")}>
                {shownLines.map((line) => {
                  if (line.kind === "panel") {
                    return (
                      <li
                        key={`panel:${line.name}`}
                        data-testid={`env-panel-${line.name}`}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 sm:flex-row sm:items-center sm:gap-3",
                          compact ? "py-1" : "py-2",
                        )}
                      >
                        <span className="font-mono text-sm text-emerald-200 [overflow-wrap:anywhere] sm:w-64 sm:shrink-0">
                          {line.name}
                          {line.source && <span className="text-muted-foreground"> ← {line.source}</span>}
                        </span>
                        <span className="text-xs text-emerald-300/80">
                          fornecida pelo e-mail do projeto no deploy (o valor não aparece aqui)
                        </span>
                      </li>
                    );
                  }
                  const { row: v, index: i } = line;
                  const name = v.key.trim();
                  const info = describe(composeByName.get(name), providedSet.has(name), links[name]);
                  const shown = visible.has(v.id);
                  const urgent = isMissing(v);
                  const labelText = info && (!compact || urgent) ? info.label : null;
                  return (
                    <li
                      key={v.id}
                      data-testid={name ? `env-row-${name}` : undefined}
                      title={compact ? info?.label : undefined}
                      className="flex flex-col gap-1"
                    >
                      <div className={cn("flex sm:flex-row", compact ? "flex-row gap-1" : "flex-col gap-2")}>
                        <Input
                          value={v.key}
                          onChange={(e) => update(v.id, { key: e.target.value })}
                          placeholder="NOME_DA_VARIAVEL"
                          className={cn("font-mono sm:w-64", compact && "h-8 w-2/5 shrink-0 text-xs")}
                          aria-label={`Nome da variável ${i + 1}`}
                        />
                        <div className="flex min-w-0 flex-1 gap-1">
                          <PasswordInput
                            value={v.value}
                            onChange={(e) => update(v.id, { value: e.target.value })}
                            placeholder={info?.placeholder ?? "valor"}
                            autoComplete="off"
                            spellCheck={false}
                            revealLabel="valor"
                            visible={shown}
                            onVisibleChange={(show) => setRowVisible(v.id, show)}
                            className={cn("font-mono", compact && "h-8 text-xs")}
                            containerClassName="flex-1"
                            aria-label={`Valor da variável ${i + 1}`}
                          />
                          {shown && v.value !== "" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Copiar valor de ${name || "variável"}`}
                              title="Copiar valor"
                              className={cn(compact && "h-8 w-8")}
                              onClick={() => void copy(v)}
                            >
                              {copied === v.id ? (
                                <Check className="h-4 w-4 text-emerald-400" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remover ${v.key || "variável"}`}
                            className={cn(compact && "h-8 w-8")}
                            onClick={() => {
                              changed();
                              setVars((prev) => (prev ?? []).filter((x) => x.id !== v.id));
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-red-400" />
                          </Button>
                        </div>
                      </div>
                      {(labelText || copied === v.id) && (
                        <span
                          className={cn(
                            "text-xs",
                            urgent ? "text-red-300" : providedSet.has(name) ? "text-emerald-300/80" : "text-muted-foreground",
                          )}
                        >
                          {labelText}
                          {copied === v.id && <span className="text-emerald-400">{labelText ? " · " : ""}copiado</span>}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div data-testid="env-footer" className="flex flex-col gap-2 border-t bg-card px-6 py-3">
              {confirmClear && (
                <div
                  data-testid="env-clear-confirm"
                  className="flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm"
                >
                  <span className="flex-1">
                    Apagar as {plural(savedCount, "variável salva", "variáveis salvas")} deste projeto
                    {filtering && hiddenSaved > 0 && <strong> — inclusive {hiddenSaved} que a pesquisa está escondendo</strong>}?
                    Vale na hora; o próximo deploy usa a lista nova.
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)} disabled={busy}>
                    Cancelar
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => void clearAll()} disabled={busy}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sim, apagar todas
                  </Button>
                </div>
              )}
              {/* celular: grade de duas colunas; tela larga: em linha, Salvar à direita */}
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center [&>button]:h-auto [&>button]:min-h-8 [&>button]:whitespace-normal [&>button]:py-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    changed();
                    setVars((prev) => [...(prev ?? []), row({ key: "", value: "" })]);
                  }}
                >
                  <Plus className="h-4 w-4" /> Adicionar variável
                </Button>
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={shownRows.length === 0}
                  onClick={() =>
                    setVisible((prev) => {
                      const next = new Set(prev);
                      for (const r of shownRows) {
                        if (allVisible) next.delete(r.id);
                        else next.add(r.id);
                      }
                      return next;
                    })
                  }
                >
                  {allVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {allVisible ? "Ocultar valores" : "Mostrar valores"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  disabled={savedCount === 0 || busy}
                  onClick={() => setConfirmClear(true)}
                >
                  <Trash2 className="h-4 w-4" /> Apagar todas
                </Button>
                <Button size="sm" className="col-span-2 sm:col-span-1 sm:ml-auto" onClick={() => void save()} disabled={busy}>
                  {busy && !confirmClear && <Loader2 className="h-4 w-4 animate-spin" />} Salvar variáveis
                </Button>
              </div>
              {notice && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> {notice}
                </span>
              )}
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
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
