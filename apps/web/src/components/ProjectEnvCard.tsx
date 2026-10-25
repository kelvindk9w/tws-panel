import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  PROJECT_EMAIL_VALUE_KEYS,
  checkHostVariable,
  isSecretVariableName,
  missingComposeVariables,
  type ComposeVariable,
  type EnvExampleVariable,
  type Project,
  type ProjectEmailConfig,
  type ProjectEmailResponse,
  type ProjectEmailValueKey,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, lowerCase, t, Trans, useI18n, type Key } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { parseDotenv } from "@/lib/dotenv";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { EnvEmailAdvice } from "@/components/project/EnvEmailAdvice";
import { emailAdvice } from "@/lib/email-env-advice";
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

/** Linha do formulário; `suggested` = veio da lista do compose (ou do .env.example), ainda não salva. */
interface EnvRow extends EnvVar {
  id: number;
  suggested?: boolean;
}

/** Um .env de verdade tem poucos KB; acima disso não é o arquivo certo. */
const MAX_ENV_FILE = 256 * 1024;

let nextRowId = 1;
const row = (v: EnvVar, suggested = false): EnvRow => ({ id: nextRowId++, ...v, ...(suggested ? { suggested } : {}) });

/** O que, além das salvas, vira linha sugerida: o compose e o .env.example, menos o que o painel fornece. */
interface Suggestions {
  compose: ComposeVariable[] | null;
  example: EnvExampleVariable[];
  provided: ReadonlySet<string>;
}

/**
 * Linhas da tela: as salvas; cada variável do compose que ainda não está na
 * lista (obrigatórias primeiro); e os nomes do .env.example que o compose não
 * cita (o app pode lê-los por env_file) — prontas para receber o valor. O que
 * o e-mail do projeto fornece não vira campo vazio: aparece como linha do painel.
 */
function buildRows(saved: EnvVar[], { compose, example, provided }: Suggestions): EnvRow[] {
  const listed = new Set([...saved.map((v) => v.key), ...provided]);
  const pending = (compose ?? []).filter((v) => !listed.has(v.name));
  const inCompose = new Set((compose ?? []).map((v) => v.name));
  const fromExample = [...new Set(example.map((v) => v.name))].filter((n) => !listed.has(n) && !inCompose.has(n));
  return [
    ...saved.map((v) => row(v)),
    ...[...pending.filter((v) => v.required), ...pending.filter((v) => !v.required)].map((v) =>
      row({ key: v.name, value: "" }, true),
    ),
    ...fromExample.map((name) => row({ key: name, value: "" }, true)),
  ];
}

/** Erro da API: mensagem do servidor (ou o código traduzido); qualquer outro erro mostra a frase própria da tela. */
function envErrorText(err: unknown, key: Key, params?: Record<string, string | number>): string {
  return err instanceof ApiRequestError ? apiErrorText(err, key, params) : t(key, params);
}

/** Falha ao revelar: sempre diz QUAL variável; com erro da API, acrescenta o motivo do servidor. */
function revealErrorText(err: unknown, name: string): string {
  const reason = envErrorText(err, "env.revealFailed", { name });
  const plain = t("env.revealFailed", { name });
  return reason === plain ? plain : t("env.revealFailedWhy", { name, reason });
}

/**
 * Texto com número e plural ("1 variável" / "3 variáveis"). O plural escolhido é
 * só singular (1) ou plural (qualquer outro número, inclusive 0), como sempre
 * foi na tela; o número mostrado vem de `{n}`.
 */
function plural(key: Key, n: number): string {
  return t(key, { count: n === 1 ? 1 : 2, n });
}

/** Variáveis citadas num padrão (`${MAIL_FROM:?…}` → MAIL_FROM). */
function namesIn(text: string): string[] {
  return [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
}

/** Quem vence quando há valor salvo com nome do e-mail: depende do tipo (só compose e Dockerfile são conhecidos). */
type ProvidedMode = "compose" | "dockerfile" | "other";
const PROVIDED_LABEL: Record<ProvidedMode, Key> = {
  compose: "env.describe.provided.label",
  dockerfile: "env.describe.provided.labelDockerfile",
  other: "env.describe.provided.labelNeutral",
};
const PROVIDED_HELP: Record<ProvidedMode, Key> = {
  compose: "env.provided.help",
  dockerfile: "env.provided.helpDockerfile",
  other: "env.provided.helpNeutral",
};

/**
 * O que a linha significa (rótulo e placeholder). `linkedTo` = valor do e-mail
 * ligado a ela; `exampleFile` = o .env.example que a cita (quando o compose não cita).
 */
function describe(
  name: string,
  cv: ComposeVariable | undefined,
  provided: boolean,
  linkedTo?: string,
  exampleFile?: string,
  mode: ProvidedMode = "compose",
): { label: string; placeholder: string } | null {
  if (linkedTo) {
    // a ligação vence o valor salvo aqui (deploy-service.ts, envForProject)
    return {
      label: t("env.describe.ignored.label", { name, linkedTo }),
      placeholder: t("env.describe.ignored.placeholder"),
    };
  }
  if (provided) {
    return {
      label: t(PROVIDED_LABEL[mode]),
      placeholder: t("env.describe.provided.placeholder"),
    };
  }
  if (!cv && exampleFile) {
    return {
      label: t("env.describe.example.label", { file: exampleFile }),
      placeholder: t("env.describe.example.placeholder", { file: exampleFile }),
    };
  }
  if (!cv) return null;
  if (cv.required && cv.alternatives?.length) {
    const alt = cv.alternatives.join(t("env.describe.or"));
    return { label: t("env.describe.alt", { alt }), placeholder: t("env.describe.alt", { alt }) };
  }
  if (cv.required) return { label: t("env.describe.required.label"), placeholder: t("env.describe.required.placeholder") };
  if (cv.defaultValue !== null && cv.defaultValue.includes("${")) {
    const from = namesIn(cv.defaultValue).join(" / ");
    return { label: t("env.describe.fallback.label", { from }), placeholder: t("env.describe.fallback.placeholder", { from }) };
  }
  if (cv.defaultValue !== null) {
    const d = cv.defaultValue || t("env.describe.empty");
    return { label: t("env.describe.default.label", { value: d }), placeholder: t("env.describe.default.placeholder", { value: d }) };
  }
  return { label: t("env.describe.optional.label"), placeholder: t("env.describe.optional.placeholder") };
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

/**
 * Linha da lista: uma variável editável ou uma que o e-mail do projeto entrega
 * (não editável). `onDemand` = a senha da caixa (e o que vale o mesmo): a
 * listagem não traz o valor, que é buscado na rota própria ao clicar no olho
 * (`value` fica vazio até lá). Sem `value` nem `onDemand` = servidor antigo,
 * que não manda os valores.
 */
type Line =
  | { kind: "row"; row: EnvRow; index: number }
  | { kind: "panel"; name: string; source?: string; value?: string; onDemand?: boolean };

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
 * · Do painel) e densidade (Lista / Compacta, guardada no navegador).
 * "Mostrar/Ocultar valores" é o PADRÃO de todas as linhas (existentes, novas,
 * importadas e as que voltam ao mudar a pesquisa); o olho de uma linha
 * sobrepõe só ela, e o botão global descarta os olhos e vale também para as
 * que a pesquisa esconde (as senhas sob demanda são pedidas sob esse clique,
 * todas). "Apagar todas" e "Salvar" valem para todas — a tela avisa.
 * O que o e-mail do projeto entrega (e o que está ligado a ele) aparece na
 * lista já preenchido, com o olho e sem edição (o valor muda no E-mail). A
 * senha da caixa também tem o olho (decisão do dono, 04/10/2026), mas o valor
 * só é buscado quando a pessoa pede — rota própria, com Auditoria. Faltando inclui os nomes do .env.example sem
 * valor (o app pode lê-los por env_file): aviso, não bloqueia o deploy.
 */
export function ProjectEnvCard({ project }: { project: Project }) {
  const { t } = useI18n();
  const [vars, setVars] = useState<EnvRow[] | null>(null);
  // O que o compose do projeto interpola (null = não é compose)
  const [composeVars, setComposeVars] = useState<ComposeVariable[] | null>(null);
  // Variáveis que o painel fornece sozinho (e-mail do projeto ativo)
  const [provided, setProvided] = useState<string[]>([]);
  // Variáveis do app ligadas a valores do e-mail (SMTP_SENHA → SMTP_PASS)
  const [links, setLinks] = useState<Record<string, ProjectEmailValueKey>>({});
  // Configuração do e-mail do projeto (undefined = carregando; null = não deu para consultar)
  const [emailConfig, setEmailConfig] = useState<ProjectEmailConfig | null | undefined>(undefined);
  // Valores do que o painel fornece (sem a senha da caixa; null = servidor antigo)
  const [providedValues, setProvidedValues] = useState<Record<string, string> | null>(null);
  // Senha da caixa (e o que vale o mesmo) buscada a pedido, pelo olho
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // Nomes do .env.example do código (o app pode lê-los por env_file)
  const [example, setExample] = useState<EnvExampleVariable[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [density, setDensity] = useState<Density>(readDensity);
  // linhas mexidas com a pesquisa ativa: não somem enquanto a pessoa edita
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [savedCount, setSavedCount] = useState(0);
  // "Mostrar/Ocultar valores": o PADRÃO de todas as linhas (novas, importadas e as
  // que voltam com a pesquisa). Só em memória: nunca vai para localStorage/URL.
  const [showAll, setShowAll] = useState(false);
  // olho de uma linha: sobrepõe o padrão só nela; o botão global os descarta
  const [rowOverride, setRowOverride] = useState<Record<number, boolean>>({});
  // idem para as linhas do e-mail do projeto (por nome)
  const [panelOverride, setPanelOverride] = useState<Record<string, boolean>>({});
  // buscas de senha em andamento: um segundo pedido do mesmo nome reaproveita a busca
  const inFlight = useRef<Map<string, Promise<string>>>(new Map());
  const [loadingNames, setLoadingNames] = useState<Set<string>>(new Set());
  // Época: sobe a cada clique no botão global. Uma resposta tardia de um olho só
  // vale se a época e a última vontade daquela linha (eyeSeq) ainda forem as do
  // clique que a pediu — nunca revelar depois de a pessoa ter mandado ocultar.
  const epoch = useRef(0);
  const eyeSeq = useRef<Record<string, number>>({});
  // falhas ao buscar, por nome (cada uma diz qual variável ficou oculta)
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
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
      providedValues?: Record<string, string>;
      links?: Record<string, ProjectEmailValueKey>;
      example?: { files: string[]; variables: EnvExampleVariable[] } | null;
    }>(`/api/projects/${project.id}/env`)
      .then((r) => {
        const compose = r.compose?.variables ?? null;
        const exampleVars = r.example?.variables ?? [];
        setComposeVars(compose);
        setProvided(r.provided ?? []);
        setProvidedValues(r.providedValues ?? null);
        setLinks(r.links ?? {});
        setExample(exampleVars);
        setSavedCount(r.vars.length);
        setVars(buildRows(r.vars, { compose, example: exampleVars, provided: new Set(r.provided ?? []) }));
      })
      .catch((err: unknown) => {
        setVars([]);
        setError(envErrorText(err, "env.loadFailed"));
      });
  }, [project.id]);

  useEffect(() => {
    apiFetch<ProjectEmailResponse>(`/api/projects/${project.id}/email`)
      .then((r) => setEmailConfig(r.email ?? null))
      .catch(() => setEmailConfig(null));
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

  const isRowVisible = (id: number) => rowOverride[id] ?? showAll;
  /** Linha do e-mail à mostra: o padrão/olho decide, mas o valor buscado a pedido precisa já ter chegado. */
  const isPanelVisible = (l: { name: string; onDemand?: boolean }) =>
    (panelOverride[l.name] ?? showAll) && (!l.onDemand || revealed[l.name] !== undefined);

  function setRowVisible(id: number, show: boolean) {
    setRowOverride((prev) => ({ ...prev, [id]: show }));
  }

  function setPanelVisible(name: string, show: boolean) {
    setPanelOverride((prev) => ({ ...prev, [name]: show }));
  }

  /**
   * Busca o valor das variáveis do painel que a listagem não traz (a senha
   * da caixa) — uma chamada por variável (não há rota em lote; são poucas, as
   * das caixas), em paralelo, cada uma registrada na Auditoria. Só roda sob
   * clique da pessoa. O valor vai para a memória (cache), mas QUEM decide se
   * aparece é o estado de mostrar/ocultar. Devolve os nomes que deram certo; a
   * falha de uma vira aviso com o nome, deixa só aquela oculta e não trava as demais.
   */
  async function reveal(names: string[]): Promise<string[]> {
    const jobs = names.map(async (name) => {
      if (revealed[name] !== undefined) return name;
      let job = inFlight.current.get(name);
      if (!job) {
        setLoadingNames((prev) => new Set(prev).add(name));
        job = apiFetch<{ name: string; value: string }>(
          `/api/projects/${project.id}/env/provided/${encodeURIComponent(name)}`,
        )
          .then((r) => {
            setRevealed((prev) => ({ ...prev, [name]: r.value }));
            setRevealErrors(({ [name]: _gone, ...rest }) => rest);
            return r.value;
          })
          .catch((err: unknown) => {
            setRevealErrors((prev) => ({ ...prev, [name]: revealErrorText(err, name) }));
            throw err;
          })
          .finally(() => {
            inFlight.current.delete(name);
            setLoadingNames((prev) => {
              const next = new Set(prev);
              next.delete(name);
              return next;
            });
          });
        inFlight.current.set(name, job);
      }
      await job;
      return name;
    });
    const results = await Promise.allSettled(jobs);
    return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }

  /**
   * Botão global: o novo estado vira o padrão de TODAS as linhas (as que a
   * pesquisa esconde também) e os olhos individuais são descartados — inclusive
   * os que ainda esperam resposta (época). Ao mostrar, as senhas ainda não
   * buscadas são pedidas ao servidor, todas; quando chegam, aparecem sozinhas
   * se o estado ainda for "mostrar".
   */
  function setAllVisible(show: boolean) {
    epoch.current += 1;
    setRowOverride({});
    setPanelOverride({});
    setShowAll(show);
    if (!show) return;
    const pending = lines.flatMap((l) =>
      l.kind === "panel" && l.onDemand && revealed[l.name] === undefined ? [l.name] : [],
    );
    if (pending.length > 0) void reveal(pending);
  }

  /**
   * Olho de uma linha do painel: a senha é buscada na primeira vez. Clicar de
   * novo enquanto ela carrega cancela (fica oculta). A resposta só vale se
   * nada mudou desde o clique.
   */
  async function togglePanel(line: { name: string; onDemand?: boolean }, show: boolean) {
    const mine = (eyeSeq.current[line.name] = (eyeSeq.current[line.name] ?? 0) + 1);
    const at = epoch.current;
    setPanelVisible(line.name, show);
    if (show && line.onDemand && revealed[line.name] === undefined) {
      // a intenção (olho já como "ocultar") vale durante a carga; o valor só aparece quando chega
      const ok = (await reveal([line.name])).length > 0;
      if (!ok && eyeSeq.current[line.name] === mine && epoch.current === at) {
        // falhou e ninguém mudou de ideia: volta ao padrão e ao rótulo de mostrar
        setPanelOverride(({ [line.name]: _gone, ...rest }) => rest);
      }
    }
  }

  /** As ligações foram salvas: o e-mail passa a fornecer esses nomes (o valor vem do painel, nunca copiado). */
  function onEmailLinked(next: Record<string, ProjectEmailValueKey>, names: string[]) {
    // `next` é o mapa guardado inteiro (pode ter ligações que o e-mail não entrega agora);
    // a tela só passa a mostrar como fornecidas as que acabaram de ser ligadas
    setEmailConfig((c) => (c ? { ...c, envLinks: next } : c));
    setLinks((prev) => ({ ...prev, ...Object.fromEntries(names.filter((n) => next[n]).map((n) => [n, next[n]!])) }));
    setProvided((prev) => [...new Set([...prev, ...names])].sort());
    // a linha vazia sugerida pelo compose some: o painel fornece o valor
    setVars((prev) => (prev ?? []).filter((v) => !(v.suggested && v.value === "" && names.includes(v.key.trim()))));
    setNotice(t("env.email.linked", { names: names.join(", ") }));
  }

  /** Atalho de variável manual (SMTP_SECURE=false): só põe a linha na tabela; salvar é com a pessoa. */
  function addManualRow(name: string, value: string) {
    changed();
    const existing = (vars ?? []).find((v) => v.key.trim() === name);
    if (existing) update(existing.id, { value });
    else setVars((prev) => [...(prev ?? []), row({ key: name, value }, true)]);
    setNotice(t("env.email.manual.added", { name }));
  }

  /** `key`: "row:<id>" ou "panel:<nome>" — onde mostrar o "copiado". */
  async function copy(key: string, value: string) {
    if (await copyText(value)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  }

  async function put(list: EnvVar[]): Promise<EnvVar[]> {
    const res = await apiFetch<{ vars: EnvVar[] }>(`/api/projects/${project.id}/env`, {
      method: "PUT",
      body: JSON.stringify({ vars: list }),
    });
    setSavedCount(res.vars.length);
    const rows = buildRows(res.vars, { compose: composeVars, example, provided: new Set(provided) });
    setVars(rows);
    // os olhos seguem a variável (pelo nome) para o novo conjunto de linhas: o
    // que a pessoa ocultou não reaparece ao salvar
    const nameOf = new Map((vars ?? []).map((v) => [v.id, v.key.trim()]));
    setRowOverride((prev) => {
      const byName = new Map<string, boolean>();
      for (const [id, val] of Object.entries(prev)) {
        const name = nameOf.get(Number(id));
        if (name) byName.set(name, val);
      }
      const next: Record<number, boolean> = {};
      for (const r of rows) {
        const val = byName.get(r.key.trim());
        if (val !== undefined) next[r.id] = val;
      }
      return next;
    });
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
      setNotice(t("env.saved"));
    } catch (err) {
      setError(envErrorText(err, "env.saveFailed"));
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
      setNotice(t("env.cleared"));
    } catch (err) {
      setError(envErrorText(err, "env.clearFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setError(null);
    setImported(null);
    if (file.size > MAX_ENV_FILE) {
      setError(t("env.import.tooBig", { file: file.name }));
      return;
    }
    const { vars: read, skipped } = parseDotenv(await file.text());
    if (read.length === 0) {
      setError(t("env.import.empty", { file: file.name }));
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
    const oddHosts = read.filter((v) => checkHostVariable(v.key, v.value) !== null).length;
    setImported(
      t("env.import.summary", {
        read: plural("env.import.read", read.length),
        file: file.name,
        updated: plural("env.import.updated", updated),
        added: plural("env.import.added", added.length),
      }) +
        (skipped.length > 0
          ? ` ${t("env.import.skipped", { count: skipped.length, lines: skipped.join(", ") })}`
          : "") +
        (oddHosts > 0 ? ` ${plural("env.import.hosts", oddHosts)}` : "") +
        ` ${t("env.import.notSaved")}`,
    );
  }

  // compose: o override do e-mail vem por cima; Dockerfile: o valor salvo aqui vence o do e-mail
  const mode: ProvidedMode =
    project.detection?.type === "compose" ? "compose" : project.detection?.type === "dockerfile" ? "dockerfile" : "other";
  const staticSite = project.detection?.type === "static" || project.detection?.type === "static-node";
  const providedSet = new Set(provided);
  const composeByName = new Map((composeVars ?? []).map((v) => [v.name, v]));
  const defined = new Set([
    ...(vars ?? []).filter((v) => v.value !== "").map((v) => v.key.trim()),
    ...provided,
  ]);
  const advice = emailAdvice(
    composeVars,
    new Set((vars ?? []).filter((v) => v.value !== "").map((v) => v.key.trim())),
    providedSet,
    emailConfig ?? null,
    links,
  );
  const missing = missingComposeVariables(composeVars ?? [], defined);
  const missingSet = new Set(missing);
  // O que o e-mail entrega com o nome padrão, na ordem da tela do e-mail…
  const delivered = PROJECT_EMAIL_VALUE_KEYS.filter((k) => providedSet.has(k));
  // …e as variáveis do app ligadas a ele (SMTP_SENHA ← SMTP_PASS)
  const linked = provided.filter((n) => !(PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(n));
  // O que o e-mail fornece vira linha do painel, com o valor; a senha (fora
  // da listagem) é buscada a pedido.
  // Nome padrão com valor salvo aqui: a linha salva aparece no lugar da do
  // painel (em projeto compose o container ainda recebe o valor do e-mail:
  // o salvo só vale na interpolação do .env). Ligada: a ligação vence sempre.
  const overridden = new Set((vars ?? []).filter((v) => v.value !== "").map((v) => v.key.trim()));
  const lines: Line[] = [
    ...(vars ?? []).map((row, index): Line => ({ kind: "row", row, index })),
    ...[...delivered, ...linked]
      .filter((name) => links[name] !== undefined || !overridden.has(name))
      .map(
        (name): Line => ({
          kind: "panel",
          name,
          ...(links[name] ? { source: links[name] } : {}),
          ...(providedValues === null
            ? {}
            : providedValues[name] !== undefined
              ? { value: providedValues[name] }
              : { value: revealed[name] ?? "", onDemand: true }),
        }),
      ),
  ];

  // Nomes do .env.example que o compose não cita: o app pode lê-los por env_file
  const exampleFile = new Map<string, string>();
  for (const v of example) if (!exampleFile.has(v.name)) exampleFile.set(v.name, v.file);
  const isMissing = (r: EnvRow) => {
    const name = r.key.trim();
    return r.value === "" && !providedSet.has(name) && missingSet.has(name);
  };
  /** Do .env.example, sem valor nem fornecida pelo painel: aviso (não bloqueia o deploy). */
  const isExampleMissing = (r: EnvRow) => {
    const name = r.key.trim();
    return r.value === "" && exampleFile.has(name) && !composeByName.has(name) && !providedSet.has(name);
  };
  const exampleMissingCount = (vars ?? []).filter(isExampleMissing).length;
  const inFilter = (l: Line, f: Filter) => {
    if (f === "missing") return l.kind === "row" && (isMissing(l.row) || isExampleMissing(l.row));
    if (f === "filled") return l.kind === "panel" || l.row.value !== "";
    if (f === "panel") return providedSet.has(lineName(l));
    return true;
  };
  const q = lowerCase(query.trim());
  const inQuery = (l: Line) => {
    if (!q) return true;
    const name = lineName(l);
    if (lowerCase(name).includes(q)) return true;
    if (l.kind === "panel") {
      if (lowerCase(l.source ?? "").includes(q)) return true;
      // a senha da caixa nunca entra na pesquisa, com nome nenhum
      return isPanelVisible(l) && !l.onDemand && !isSecretVariableName(name) && lowerCase(l.value ?? "").includes(q);
    }
    // valor: só o que já está à mostra, e nunca o de nome com cara de segredo
    return isRowVisible(l.row.id) && !isSecretVariableName(name) && lowerCase(l.row.value).includes(q);
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
  // linhas do e-mail com valor que dá para mostrar (a senha inclusive, buscada a pedido)
  const compact = density === "compact";

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Variable className="h-4 w-4" /> {t("env.title")}
        </CardTitle>
        <CardDescription>
          {t("env.description")}
        </CardDescription>
        {staticSite && (
          <p data-testid="env-static-note" className="flex items-start gap-2 pt-2 text-sm text-amber-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            {t("env.staticNote")}
          </p>
        )}
        {project.detection?.type === "node-server" && (
          <p data-testid="env-next-note" className="flex items-start gap-2 pt-2 text-sm text-amber-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            {t("env.nextNote")}
          </p>
        )}
        {composeVars && composeVars.length > 0 && (
          <p data-testid="compose-vars" className="mt-2 rounded-md border bg-secondary/20 p-3 text-xs text-muted-foreground">
            {t("env.compose.intro", { variables: plural("env.count.variables", composeVars.length) })}
            {missing.length > 0 ? (
              <>
                {" "}
                {/* poucas: os nomes aqui mesmo; muitas: o filtro Faltando mostra só elas */}
                {missing.length <= 5 ? (
                  <Trans
                    k="env.compose.missingNames"
                    params={{ count: missing.length, names: missing.join(", ") }}
                    components={{ b: <strong className="text-red-400" /> }}
                  />
                ) : (
                  <>
                    <Trans
                      k="env.compose.missingMany"
                      params={{ count: missing.length }}
                      components={{ b: <strong className="text-red-400" /> }}
                    />{" "}
                    <button
                      type="button"
                      className="text-sky-400 underline"
                      onClick={() => search("", "missing")}
                    >
                      {t("env.compose.seeMissing", { count: missing.length })}
                    </button>
                  </>
                )}
              </>
            ) : (
              ` ${t("env.compose.allSet")}`
            )}
          </p>
        )}
        {emailConfig !== undefined && vars !== null && advice.show && (
          <EnvEmailAdvice
            projectId={project.id}
            advice={advice}
            mode={mode}
            links={emailConfig?.envLinks ?? {}}
            onLinked={onEmailLinked}
            onAddRow={addManualRow}
          />
        )}
        {provided.length > 0 && (
          <div data-testid="env-provided" className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
            {delivered.length > 0 && (
              <p className="flex items-start gap-2 text-emerald-300">
                <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <Trans
                    k="env.provided.delivers"
                    params={{ names: delivered.join(", ") }}
                    components={{ mono: <span className="font-mono" /> }}
                  />
                </span>
              </p>
            )}
            {linked.length > 0 && (
              <p className="mt-1 text-emerald-300 [overflow-wrap:anywhere]">
                <Trans
                  k="env.provided.linked"
                  params={{ names: linked.map((n) => (links[n] ? `${n} ← ${links[n]}` : n)).join(", ") }}
                  components={{ mono: <span className="font-mono" /> }}
                />
              </p>
            )}
            <p className="mt-2 text-muted-foreground">
              <Trans
                k={PROVIDED_HELP[mode]}
                components={{
                  link: (c) => (
                    <Link to={`/projects/${project.id}/email`} className="text-sky-400 underline">
                      {c}
                    </Link>
                  ),
                }}
              />
            </p>
          </div>
        )}
        {exampleMissingCount > 0 && (
          <div
            data-testid="env-example-missing"
            className="mt-2 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {t("env.example.count", { count: exampleMissingCount })} {t("env.example.help")}{" "}
              <button type="button" className="text-sky-400 underline" onClick={() => search("", "missing")}>
                {t("env.example.seeMissing")}
              </button>
            </span>
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
                  placeholder={t("env.search.placeholder")}
                  aria-label={t("env.search.label")}
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-8 pr-9 [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t("env.search.clear")}
                    onClick={() => search("")}
                    className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div role="group" aria-label={t("env.filter.label")} className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["all", t("env.filter.all")],
                      ["missing", t("env.filter.missing", { count: counts.missing })],
                      ["filled", t("env.filter.filled", { count: counts.filled })],
                      ["panel", t("env.filter.panel", { count: counts.panel })],
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
                <div role="group" aria-label={t("env.density.label")} className="ml-auto flex rounded-md border p-0.5">
                  {(
                    [
                      ["list", t("env.density.list"), LayoutList],
                      ["compact", t("env.density.compact"), Rows3],
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
                  ? t("env.count.filtered", { shown: shownLines.length, total: plural("env.count.variables", lines.length) })
                  : plural("env.count.variables", lines.length)}
              </p>
              {filtering && (
                <p data-testid="env-filter-note" className="text-xs text-amber-300/90">
                  {t("env.filterNote", { shown: shownLines.length, total: lines.length })}
                </p>
              )}
            </div>

            {/* a lista rola aqui dentro: a página não ganha uma barra enorme */}
            <div
              data-testid="env-list"
              data-density={density}
              className="max-h-[calc(100dvh-30rem)] min-h-[10rem] overflow-y-auto border-t px-6 py-3"
            >
              {lines.length === 0 && <p className="text-sm text-muted-foreground">{t("env.empty")}</p>}
              {lines.length > 0 && shownLines.length === 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {t("env.noMatch")}
                  <Button variant="outline" size="sm" onClick={() => search("", "all")}>
                    {t("env.clearSearch")}
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
                          "flex flex-col gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3",
                          compact ? "py-1" : "py-2",
                        )}
                      >
                        <div className={cn("flex sm:flex-row sm:items-center", compact ? "flex-row gap-1" : "flex-col gap-2")}>
                          <span
                            className={cn(
                              "font-mono text-sm text-emerald-200 [overflow-wrap:anywhere] sm:w-64 sm:shrink-0",
                              compact && "w-2/5 shrink-0 text-xs",
                            )}
                          >
                            {line.name}
                            {line.source && <span className="text-muted-foreground"> ← {line.source}</span>}
                          </span>
                          <div className="flex min-w-0 flex-1 items-center gap-1">
                            {line.value === undefined ? (
                              <span className="text-xs text-emerald-300/80">{t("env.panel.deliveredOnDeploy")}</span>
                            ) : (
                              <>
                                <PasswordInput
                                  value={line.value}
                                  readOnly
                                  revealLabel={t("env.row.valueNoun")}
                                  visible={(panelOverride[line.name] ?? showAll) && (!line.onDemand || revealed[line.name] !== undefined || loadingNames.has(line.name))}
                                  onVisibleChange={(show) => void togglePanel(line, show)}
                                  {...(line.onDemand && !line.value ? { placeholder: "••••••••" } : {})}
                                  className={cn("cursor-default font-mono", compact && "h-8 text-xs")}
                                  containerClassName="flex-1"
                                  aria-label={t("env.panel.valueOf", { name: line.name })}
                                />
                                {loadingNames.has(line.name) && (
                                  <Loader2
                                    role="status"
                                    aria-label={t("env.revealing", { name: line.name })}
                                    className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                                  />
                                )}
                                {isPanelVisible(line) && line.value !== "" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("env.row.copyValueOf", { name: line.name })}
                                    title={t("env.row.copyValue")}
                                    className={cn(compact && "h-8 w-8")}
                                    onClick={() => void copy(`panel:${line.name}`, line.value!)}
                                  >
                                    {copied === `panel:${line.name}` ? (
                                      <Check className="h-4 w-4 text-emerald-400" />
                                    ) : (
                                      <Copy className="h-4 w-4" />
                                    )}
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {(!compact || copied === `panel:${line.name}`) && (
                          <span className="text-xs text-emerald-300/80">
                            {!compact && (
                              <Trans
                                k="env.panel.comesFrom"
                                components={{
                                  link: (c) => (
                                    <Link to={`/projects/${project.id}/email`} className="text-sky-400 underline">
                                      {c}
                                    </Link>
                                  ),
                                }}
                              />
                            )}
                            {copied === `panel:${line.name}` && (
                              <span className="text-emerald-400">{compact ? "" : " · "}{t("env.copied")}</span>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  }
                  const { row: v, index: i } = line;
                  const name = v.key.trim();
                  const info = describe(name, composeByName.get(name), providedSet.has(name), links[name], exampleFile.get(name), mode);
                  const shown = isRowVisible(v.id);
                  const urgent = isMissing(v);
                  const fromExample = isExampleMissing(v);
                  const ignored = links[name] !== undefined;
                  const labelText = info && (!compact || urgent || fromExample || ignored) ? info.label : null;
                  const copyKey = `row:${v.id}`;
                  const hostCheck = checkHostVariable(name, v.value);
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
                          placeholder={t("env.row.namePlaceholder")}
                          className={cn("font-mono sm:w-64", compact && "h-8 w-2/5 shrink-0 text-xs")}
                          aria-label={t("env.row.nameLabel", { n: i + 1 })}
                        />
                        <div className="flex min-w-0 flex-1 gap-1">
                          <PasswordInput
                            value={v.value}
                            onChange={(e) => update(v.id, { value: e.target.value })}
                            placeholder={info?.placeholder ?? t("env.row.valuePlaceholder")}
                            autoComplete="off"
                            spellCheck={false}
                            revealLabel={t("env.row.valueNoun")}
                            visible={shown}
                            onVisibleChange={(show) => setRowVisible(v.id, show)}
                            className={cn("font-mono", compact && "h-8 text-xs")}
                            containerClassName="flex-1"
                            aria-label={t("env.row.valueLabel", { n: i + 1 })}
                          />
                          {shown && v.value !== "" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("env.row.copyValueOf", { name: name || t("env.row.variableFallback") })}
                              title={t("env.row.copyValue")}
                              className={cn(compact && "h-8 w-8")}
                              onClick={() => void copy(copyKey, v.value)}
                            >
                              {copied === copyKey ? (
                                <Check className="h-4 w-4 text-emerald-400" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("env.row.remove", { name: v.key || t("env.row.variableFallback") })}
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
                      {hostCheck && (
                        <div
                          data-testid={`env-host-warning-${name}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
                        >
                          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                            {t("env.host.warn", {
                              name,
                              problems: hostCheck.problems.map((p) => t(`env.host.problem.${p}` as Key)).join(", "),
                            })}
                            {hostCheck.suggestion && !hostCheck.hasCredentials && !isSecretVariableName(name)
                              ? t("env.host.suggest", { value: hostCheck.suggestion })
                              : ""}
                          </span>
                          {hostCheck.suggestion && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-auto min-h-7 py-1"
                              aria-label={t("env.host.fixLabel", { name })}
                              onClick={() => {
                                changed();
                                update(v.id, { value: hostCheck.suggestion! });
                              }}
                            >
                              {t("env.host.fix")}
                            </Button>
                          )}
                        </div>
                      )}
                      {(labelText || copied === copyKey) && (
                        <span
                          className={cn(
                            "text-xs",
                            urgent
                              ? "text-red-300"
                              : fromExample || ignored
                                ? "text-amber-300"
                                : providedSet.has(name)
                                  ? "text-emerald-300/80"
                                  : "text-muted-foreground",
                          )}
                        >
                          {labelText}
                          {copied === copyKey && <span className="text-emerald-400">{labelText ? " · " : ""}{t("env.copied")}</span>}
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
                    {t("env.clear.confirm", { variables: plural("env.count.saved", savedCount) })}
                    {filtering && hiddenSaved > 0 && <strong>{t("env.clear.hidden", { count: hiddenSaved })}</strong>}
                    {t("env.clear.tail")}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)} disabled={busy}>
                    {t("env.clear.cancel")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => void clearAll()} disabled={busy}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("env.clear.yes")}
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
                  <Plus className="h-4 w-4" /> {t("env.footer.add")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <FileUp className="h-4 w-4" /> {t("env.footer.import")}
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
                  onClick={() => setAllVisible(!showAll)}
                >
                  {showAll && loadingNames.size > 0 ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : showAll ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  {showAll ? t("env.footer.hideValues") : t("env.footer.showValues")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  disabled={savedCount === 0 || busy}
                  onClick={() => setConfirmClear(true)}
                >
                  <Trash2 className="h-4 w-4" /> {t("env.footer.clearAll")}
                </Button>
                <Button size="sm" className="col-span-2 sm:col-span-1 sm:ml-auto" onClick={() => void save()} disabled={busy}>
                  {busy && !confirmClear && <Loader2 className="h-4 w-4 animate-spin" />} {t("env.footer.save")}
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
              {Object.entries(revealErrors).map(([name, msg]) => (
                <p key={name} role="alert" className="text-sm text-destructive">
                  {msg}
                </p>
              ))}
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
