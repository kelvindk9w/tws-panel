/**
 * compose-model.ts — o que um compose de projeto PODE pedir ao Docker.
 *
 * Os guardrails antigos eram uma lista do que se proíbe (`privileged: true`
 * literal, o texto "/var/run/docker.sock") sobre o YAML cru: `privileged:
 * "true"`, `${PRIV:-true}`, um merge `<<: *x`, `include:`/`extends:`, um
 * volume `/:/host`, `cap_add`, `pid: host`, `devices`, volumes e redes
 * externos passavam todos (achado A1 da auditoria) — e cada um deles vira
 * root na VPS.
 *
 * Aqui é o contrário: uma LISTA DO QUE SE PERMITE, aplicada ao modelo que o
 * próprio `docker compose config --format json` produz (merge, include,
 * extends e interpolação já resolvidos, com os mesmos -f, --env-file e nome
 * de projeto do deploy). O mesmo verificador também roda sobre o YAML cru
 * (pré-checagem da tela): valores com `$` ainda não resolvidos são pulados
 * ali e conferidos de verdade no deploy.
 *
 * Permitido: portas, variáveis, volumes nomeados do próprio projeto, bind de
 * pastas DENTRO do código do projeto, redes do próprio projeto, build com
 * contexto dentro do código.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { GuardrailFinding } from "@paas/core";

/** Regras desta família que NENHUM override do operador libera (isolamento do painel). */
export const HARD_RULES: ReadonlySet<string> = new Set(["panel-image", "network-hijack", "reserved-name"]);

export interface ComposeCheckOptions {
  /** Nome do arquivo para a evidência (ex.: "docker-compose.yml"). */
  fileName: string;
  /** Pasta do código do projeto (a ÚNICA que o projeto pode montar e construir). */
  srcRoot: string;
  /** Nome do projeto no compose (`paas-<slug>`); ausente = não se sabe ainda (pré-checagem sem projeto). */
  projectName?: string;
  /** "raw": YAML cru (valores com `$` pulados); "canonical": saída do `docker compose config`. */
  mode: "raw" | "canonical";
  /** Rede compartilhada do proxy (`paas-net`): o override do painel a declara como externa. */
  panelNetwork?: string;
  /** Slug do projeto: o único alias que o override do painel dá ao serviço web na rede do proxy. */
  slug?: string;
  /** Serviço web que o painel liga à rede do proxy (único autorizado a entrar nela). */
  proxyService?: string;
  /** Slugs dos OUTROS projetos: nomes que o DNS da rede do proxy já responde. */
  otherSlugs?: readonly string[];
  /** Repositórios de imagem do painel (alpine, caddy, nginx, node, stalwart…): um build não pode regravar a tag deles. */
  protectedImages?: readonly string[];
  /** (interno) redes do topo do modelo, para resolver o nome efetivo das ligações do serviço. */
  topNetworks?: unknown;
}

/** Nomes que o painel usa na rede e no Docker: nenhum projeto pode se chamar assim. */
export const RESERVED_NAMES: readonly string[] = [
  "tws-panel",
  "paas-caddy",
  "paas-stalwart",
  "paas-webmail",
  "stalwart",
  "caddy",
  "localhost",
];

/** Repositório da imagem, sem registro padrão, tag nem digest (`docker.io/library/alpine:3@sha256:…` → `alpine`). */
export function imageRepository(ref: string): string {
  let repo = ref.trim().toLowerCase().split("@")[0] ?? "";
  const colon = repo.lastIndexOf(":");
  if (colon > repo.lastIndexOf("/")) repo = repo.slice(0, colon);
  repo = repo.replace(/^(index\.|registry-1\.)?docker\.io\//, "");
  return repo.replace(/^library\//, "");
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/** Valor de flag booleana que o Compose aceitaria como "ligado". */
function isOn(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !/^(false|no|off|n|0|)$/i.test(value.trim());
  return true;
}

/** Resolve o caminho como o Docker enxergaria (links seguidos), mesmo que o fim ainda não exista. */
export function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function insideRoot(root: string, target: string): boolean {
  const real = resolveRealPath(target);
  return real === root || real.startsWith(root + path.sep);
}

/** Origem e destino de um volume do serviço (forma curta ou longa). */
interface VolumeEntry {
  type: string;
  source: string;
  target: string;
  raw: string;
}

function parseVolume(entry: unknown): VolumeEntry | null {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    if (parts.length < 2) return { type: "volume", source: "", target: entry, raw: entry };
    const source = parts[0] ?? "";
    const named = !/^([./~]|[A-Za-z]:[\\/])/.test(source);
    return { type: named ? "volume" : "bind", source, target: parts[1] ?? "", raw: entry };
  }
  if (isDict(entry)) {
    const source = str(entry.source);
    return { type: str(entry.type) || (source.startsWith("/") || source.startsWith(".") ? "bind" : "volume"), source, target: str(entry.target), raw: JSON.stringify(entry) };
  }
  return null;
}

function finding(
  rule: string,
  title: string,
  opts: ComposeCheckOptions,
  service: string | undefined,
  detail: string,
  fix: string,
): GuardrailFinding {
  return {
    rule,
    level: "block",
    title,
    evidence: `${opts.fileName}: ${service ? `serviço "${service}" ` : ""}${detail}`,
    fix,
    ...(service ? { service } : {}),
  };
}

/** Modos de namespace aceitos: o do próprio container, ou o de outro serviço DO MESMO projeto. */
const SAFE_NAMESPACE_MODES: Record<string, ReadonlySet<string>> = {
  pid: new Set([""]),
  ipc: new Set(["", "private", "shareable", "none"]),
  network_mode: new Set(["", "bridge", "default", "none"]),
  cgroup: new Set(["", "private"]),
  uts: new Set([""]),
  userns_mode: new Set([""]),
};

const NAMESPACE_LABEL: Record<string, string> = {
  pid: "pid",
  ipc: "ipc",
  network_mode: "network_mode",
  cgroup: "cgroup",
  uts: "uts",
  userns_mode: "userns_mode",
};

/** Mensagem curta do que cada campo perigoso permite (para o texto do bloqueio). */
const NO_NEW_PRIVS = /^no-new-privileges(?:[:=]true)?$/;

/**
 * Recurso do próprio projeto: o nome é EXATAMENTE o que o compose geraria
 * (`<projeto>_<chave>`). Prefixo não serve: "paas-app" não pode "possuir"
 * "paas-app-outro_dados" nem "paas-app_x_dados" (de um projeto "app_x").
 */
function ownedByProject(name: string, projectName: string | undefined, key: string): boolean {
  return projectName !== undefined && name === `${projectName}_${key}`;
}

function checkService(
  name: string,
  service: Dict,
  services: Dict,
  topVolumes: Dict,
  opts: ComposeCheckOptions,
  root: string,
  out: GuardrailFinding[],
): void {
  const raw = opts.mode === "raw";
  /** No YAML cru, valor que ainda tem `${…}` só se conhece no deploy. */
  const unresolved = (value: unknown) => raw && typeof value === "string" && value.includes("$");

  // ---- privilégios (privileged-container) --------------------------------
  const priv = service.privileged;
  if (!unresolved(priv) && isOn(priv)) {
    out.push(
      finding(
        "privileged-container",
        "Container privilegiado",
        opts,
        name,
        `define privileged: ${str(priv)}`,
        "Remova `privileged` — equivale a root no host. Se o serviço precisa de algo específico, procure a opção mais estreita.",
      ),
    );
  }
  const capAdd = asList(service.cap_add).filter((c) => !unresolved(c));
  if (capAdd.length > 0) {
    out.push(
      finding(
        "privileged-container",
        "Capabilities extras no container (cap_add)",
        opts,
        name,
        `pede cap_add: ${capAdd.map(str).join(", ")}`,
        "Remova `cap_add`: capabilities como SYS_ADMIN, NET_ADMIN ou SYS_PTRACE dão controle do host a quem invadir o serviço.",
      ),
    );
  }
  const devices = [...asList(service.devices), ...asList(service.device_cgroup_rules)].filter((d) => !unresolved(d));
  if (devices.length > 0) {
    out.push(
      finding(
        "privileged-container",
        "Acesso a dispositivos do host (devices)",
        opts,
        name,
        `pede devices: ${devices.map((d) => (isDict(d) ? str(d.source) : str(d))).join(", ")}`,
        "Remova `devices`: expõe dispositivos do servidor ao container.",
      ),
    );
  }
  const securityOpt = asList(service.security_opt)
    .map(str)
    .filter((o) => !unresolved(o) && !NO_NEW_PRIVS.test(o.trim()));
  if (securityOpt.length > 0) {
    out.push(
      finding(
        "privileged-container",
        "Proteções do container desligadas (security_opt)",
        opts,
        name,
        `define security_opt: ${securityOpt.join(", ")}`,
        "Remova `security_opt` (seccomp/apparmor desligados ou perfis do host). Só `no-new-privileges` é aceito.",
      ),
    );
  }
  const sysctls = isDict(service.sysctls) ? Object.keys(service.sysctls) : asList(service.sysctls).map(str);
  if (sysctls.length > 0) {
    out.push(
      finding(
        "privileged-container",
        "Parâmetros do kernel alterados (sysctls)",
        opts,
        name,
        `define sysctls: ${sysctls.join(", ")}`,
        "Remova `sysctls`: o painel não deixa um projeto mexer no kernel do servidor.",
      ),
    );
  }
  if (service.provider !== undefined) {
    out.push(
      finding(
        "privileged-container",
        "Serviço executado por provider do Compose",
        opts,
        name,
        "usa `provider`, que roda um programa no próprio painel",
        "Remova `provider`: o painel só sobe containers.",
      ),
    );
  }

  // ---- namespaces e modos de rede (host-namespace) -------------------------
  for (const [field, allowed] of Object.entries(SAFE_NAMESPACE_MODES)) {
    const value = str(service[field]).trim();
    if (!value || unresolved(value) || allowed.has(value)) continue;
    const peer = /^service:(.+)$/.exec(value)?.[1];
    if (peer !== undefined && field !== "userns_mode" && field !== "uts" && field !== "cgroup" && peer in services) continue;
    out.push(
      finding(
        "host-namespace",
        `Container compartilha ${NAMESPACE_LABEL[field]} com o host ou com outro container`,
        opts,
        name,
        `define ${field}: ${value}`,
        `Remova \`${field}: ${value}\`. Só são aceitos o isolamento padrão ou o compartilhamento com outro serviço do MESMO compose (service:<nome>).`,
      ),
    );
  }
  for (const link of asList(service.volumes_from).map(str)) {
    if (/^container:/.test(link)) {
      out.push(
        finding(
          "host-namespace",
          "Volumes de outro container (volumes_from)",
          opts,
          name,
          `usa volumes_from: ${link}`,
          "Use apenas volumes_from de outro serviço do mesmo compose.",
        ),
      );
    }
  }
  if (asList(service.external_links).length > 0) {
    out.push(
      finding(
        "host-namespace",
        "Link para container de fora do projeto (external_links)",
        opts,
        name,
        "usa external_links",
        "Remova `external_links`: o projeto só enxerga os próprios serviços.",
      ),
    );
  }

  // ---- volumes (host-mount / shared-resource / privileged-container) --------
  for (const entry of asList(service.volumes)) {
    const vol = parseVolume(entry);
    if (!vol) continue;
    if (unresolved(vol.source) || unresolved(vol.raw)) continue;
    if (vol.source.includes("/var/run/docker.sock") || vol.source.includes("/run/docker.sock")) {
      out.push(
        finding(
          "privileged-container",
          "Socket do Docker montado no container",
          opts,
          name,
          "monta /var/run/docker.sock",
          "Evite montar o docker.sock — dá controle total sobre o host.",
        ),
      );
      continue;
    }
    if (vol.type === "bind") {
      if (vol.source.startsWith("~") || !insideRoot(root, path.resolve(root, vol.source))) {
        out.push(
          finding(
            "host-mount",
            "Pasta do servidor montada no container",
            opts,
            name,
            `monta ${vol.source || "(vazio)"} de fora da pasta do projeto`,
            "Só é permitido montar pastas DENTRO do código do projeto (ex.: ./dados). Use um volume nomeado para o resto.",
          ),
        );
      }
    } else if (vol.type !== "volume" && vol.type !== "tmpfs") {
      out.push(
        finding(
          "host-mount",
          "Tipo de montagem não permitido",
          opts,
          name,
          `usa montagem do tipo "${vol.type}"`,
          "Use volumes nomeados do projeto, tmpfs ou pastas dentro do código.",
        ),
      );
    } else if (vol.type === "volume" && vol.source && !(vol.source in topVolumes)) {
      // volume nomeado sem declaração no topo: o compose recusaria; nada a checar
    }
  }

  checkBuild(name, service, opts, root, out);
  checkEnvFiles(name, service, opts, root, out);
  checkIsolation(name, service, services, opts, out);
}

/** Labels `paas.*` (do painel) e `com.docker.compose.*` (do Compose) não vêm do compose do usuário. */
function reservedLabels(labels: unknown): string[] {
  const keys = isDict(labels) ? Object.keys(labels) : asList(labels).map((l) => str(l).split("=")[0] ?? "");
  return keys.filter((k) => k.startsWith("paas.") || k.startsWith("com.docker.compose."));
}

/** Nome que o painel ou outro projeto já usa no DNS e no Docker. */
function isReservedName(candidate: string, opts: ComposeCheckOptions, service: string): boolean {
  const n = candidate.trim().toLowerCase();
  if (!n) return false;
  const own = opts.projectName ? `${opts.projectName}-${service}` : null;
  if (n === own || (own !== null && n.startsWith(`${own}-`) && /^\d+$/.test(n.slice(own.length + 1)))) return false;
  if (opts.slug !== undefined && n === opts.slug) return false;
  return RESERVED_NAMES.includes(n) || (opts.otherSlugs ?? []).includes(n) || /^(paas|tws)[-_]/.test(n);
}

function checkIsolation(name: string, service: Dict, services: Dict, opts: ComposeCheckOptions, out: GuardrailFinding[]): void {
  const raw = opts.mode === "raw";
  const skip = (v: string) => raw && v.includes("$");
  const reserved = (what: string, value: string) =>
    out.push(
      finding(
        "reserved-name",
        "Nome reservado do painel ou de outro projeto",
        opts,
        name,
        `${what} "${value}"`,
        "Escolha outro nome: este é usado pelo painel (tws-panel, paas-*) ou por outro projeto, e dois containers com o mesmo nome na rede do proxy dividiriam o tráfego.",
      ),
    );

  const bad = reservedLabels(service.labels);
  if (bad.length > 0) {
    out.push(
      finding("reserved-name", "Label reservada do painel", opts, name, `define a label ${bad.join(", ")}`, "Remova as labels `paas.*` e `com.docker.compose.*`: o painel identifica os containers do projeto por elas."),
    );
  }
  const containerName = str(service.container_name);
  if (containerName && !skip(containerName) && isReservedName(containerName, opts, name)) reserved("usa container_name", containerName);
  const isProxy = opts.proxyService !== undefined && name === opts.proxyService;
  if (isProxy) {
    // o nome do serviço e o hostname viram nomes na rede do proxy
    if (isReservedName(name, opts, name)) reserved("tem o nome de serviço", name);
    const hostname = str(service.hostname);
    if (hostname && !skip(hostname) && isReservedName(hostname, opts, name)) reserved("usa hostname", hostname);
  }

  // redes: só o override do painel liga um serviço à rede do proxy, e só com o alias do slug
  const topNetworks = isDict(opts.topNetworks) ? opts.topNetworks : {};
  const attached: Array<[string, unknown]> = Array.isArray(service.networks)
    ? service.networks.map((k) => [str(k), null] as [string, unknown])
    : isDict(service.networks)
      ? Object.entries(service.networks)
      : [];
  for (const [key, cfg] of attached) {
    const def = topNetworks[key];
    const d = isDict(def) ? def : {};
    const effective = str(d.name) || (isOn(d.external) || opts.projectName === undefined ? key : `${opts.projectName}_${key}`);
    const aliases = (isDict(cfg) ? asList(cfg.aliases) : []).map(str).filter((a) => !skip(a));
    if (opts.panelNetwork !== undefined && effective === opts.panelNetwork) {
      if (!isProxy) {
        out.push(
          finding("network-hijack", "Serviço ligado à rede do proxy do painel", opts, name, `entra na rede ${opts.panelNetwork}, que só o painel liga (ao serviço web)`, "Remova a rede do serviço: o painel liga o serviço web a ela sozinho."),
        );
      } else {
        const extra = aliases.filter((a) => a !== opts.slug);
        if (extra.length > 0) {
          out.push(
            finding("network-hijack", "Alias na rede do proxy do painel", opts, name, `define aliases ${extra.join(", ")} na rede ${opts.panelNetwork}`, "Remova os aliases: um alias igual ao nome do painel, do e-mail ou de outro projeto desviaria o tráfego deles para este container."),
          );
        }
      }
    } else {
      for (const alias of aliases) if (isReservedName(alias, opts, name)) reserved(`define o alias (rede ${key})`, alias);
    }
  }

  // imagem: um build não pode regravar a tag de imagem do painel, e imagem de outro projeto não se reutiliza
  const build = service.build;
  const image = str(service.image);
  const tags = isDict(build) ? asList(build.tags).map(str) : [];
  const protectedRepos = new Set((opts.protectedImages ?? []).map(imageRepository));
  const ownImage = opts.projectName ? `${opts.projectName}-${name}` : null;
  for (const ref of [image, ...tags]) {
    if (!ref || skip(ref)) continue;
    const repo = imageRepository(ref);
    const panelNamespace = repo === "tws-panel" || (/^paas[-_]/.test(repo) && repo !== ownImage);
    const rewritesPanelTag = build !== undefined && build !== null && protectedRepos.has(repo);
    if (panelNamespace || rewritesPanelTag) {
      out.push(
        finding(
          "panel-image",
          "Imagem do painel ou de outro projeto",
          opts,
          name,
          `${rewritesPanelTag ? "constrói e grava a imagem" : "usa a imagem"} "${ref}"`,
          "Dê outro nome à imagem construída. O painel roda como root as imagens alpine, caddy, nginx, node, stalwart e tws-panel, e um build com o mesmo nome as substituiria no servidor.",
        ),
      );
    }
  }
}

function checkBuild(name: string, service: Dict, opts: ComposeCheckOptions, root: string, out: GuardrailFinding[]): void {
  const build = service.build;
  if (build === undefined || build === null) return;
  const raw = opts.mode === "raw";
  const unresolved = (value: unknown) => raw && typeof value === "string" && value.includes("$");
  const cfg: Dict = isDict(build) ? build : { context: build };
  const outside = (what: string, value: string) => {
    out.push(
      finding(
        "build-outside-src",
        "Build lê arquivos de fora da pasta do projeto",
        opts,
        name,
        `${what} ${value} fica fora da pasta do projeto`,
        "O contexto do build e o Dockerfile precisam estar DENTRO do código do projeto.",
      ),
    );
  };

  const context = str(cfg.context) || ".";
  if (!unresolved(context)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(context) || /^git@/.test(context)) {
      outside("o contexto de build", context);
    } else if (!insideRoot(root, path.resolve(root, context))) {
      outside("o contexto de build", context);
    } else if (typeof cfg.dockerfile === "string" && cfg.dockerfile && !unresolved(cfg.dockerfile)) {
      const dockerfile = path.resolve(root, context, cfg.dockerfile);
      if (!insideRoot(root, dockerfile)) outside("o Dockerfile", cfg.dockerfile);
    }
  }
  const additional: Array<[string, unknown]> = Array.isArray(cfg.additional_contexts)
    ? cfg.additional_contexts.map((e) => {
        const text = str(e);
        const at = text.indexOf("=");
        return [text.slice(0, at), text.slice(at + 1)] as [string, unknown];
      })
    : isDict(cfg.additional_contexts)
      ? Object.entries(cfg.additional_contexts)
      : [];
  {
    for (const [label, where] of additional) {
      const value = str(where);
      if (unresolved(value)) continue;
      if (/^(docker-image|service|target):/.test(value) || /^oci-layout:/.test(value)) continue;
      if (!insideRoot(root, path.resolve(root, value))) outside(`o contexto adicional "${label}"`, value);
    }
  }
  if (isOn(cfg.privileged) || asList(cfg.entitlements).length > 0 || asList(cfg.ssh).length > 0) {
    out.push(
      finding(
        "build-outside-src",
        "Build com permissões extras do host",
        opts,
        name,
        "pede privileged/entitlements/ssh no build",
        "Remova `privileged`, `entitlements` e `ssh` do build: dão ao build acesso ao host.",
      ),
    );
  }
  const buildNetwork = str(cfg.network).trim();
  if (buildNetwork && !unresolved(buildNetwork) && !/^(default|none|bridge)$/.test(buildNetwork)) {
    out.push(
      finding(
        "build-outside-src",
        "Build na rede do host",
        opts,
        name,
        `usa build.network: ${buildNetwork}`,
        "Remova `build.network`: o build roda isolado da rede do servidor.",
      ),
    );
  }
}

function checkEnvFiles(name: string, service: Dict, opts: ComposeCheckOptions, root: string, out: GuardrailFinding[]): void {
  const raw = opts.mode === "raw";
  for (const entry of asList(service.env_file)) {
    const file = isDict(entry) ? str(entry.path) : str(entry);
    if (!file || (raw && file.includes("$"))) continue;
    if (!insideRoot(root, path.resolve(root, file))) {
      out.push(
        finding(
          "build-outside-src",
          "env_file lê arquivo de fora da pasta do projeto",
          opts,
          name,
          `env_file ${file} fica fora da pasta do projeto`,
          "O env_file precisa estar DENTRO do código do projeto: o conteúdo dele vira variável de ambiente do container.",
        ),
      );
    }
  }
}

function checkTopLevel(model: Dict, opts: ComposeCheckOptions, root: string, out: GuardrailFinding[]): void {
  const raw = opts.mode === "raw";
  const unresolved = (value: unknown) => raw && typeof value === "string" && value.includes("$");

  for (const [key, def] of Object.entries(isDict(model.volumes) ? model.volumes : {})) {
    const cfg = isDict(def) ? def : {};
    const effective = str(cfg.name) || (opts.projectName && !isOn(cfg.external) ? `${opts.projectName}_${key}` : key);
    if (unresolved(effective)) continue;
    const owned = ownedByProject(effective, opts.projectName, key);
    const reasons: string[] = [];
    if (!owned && (isOn(cfg.external) || opts.projectName !== undefined)) {
      reasons.push(isOn(cfg.external) ? `é externo (${effective}) e não é do projeto` : `se chama "${effective}", fora do nome do projeto`);
    }
    if (cfg.driver !== undefined && str(cfg.driver) !== "local") reasons.push(`usa o driver "${str(cfg.driver)}"`);
    if (isDict(cfg.driver_opts) && Object.keys(cfg.driver_opts).length > 0) reasons.push("usa driver_opts (pode apontar para qualquer pasta do host)");
    if (reasons.length > 0) {
      out.push(
        finding(
          "shared-resource",
          "Volume que não é do próprio projeto",
          opts,
          undefined,
          `o volume "${key}" ${reasons.join(" e ")}`,
          "Use volumes nomeados simples, criados pelo próprio compose (sem `external`, `name:` de fora ou driver_opts). Volumes do painel e de outros projetos não podem ser usados.",
        ),
      );
    }
  }

  for (const [key, def] of Object.entries(isDict(model.networks) ? model.networks : {})) {
    const cfg = isDict(def) ? def : {};
    const effective = str(cfg.name) || (opts.projectName && !isOn(cfg.external) ? `${opts.projectName}_${key}` : key);
    if (unresolved(effective)) continue;
    // a rede do proxy, do jeito que o override do painel a declara
    if (opts.panelNetwork !== undefined && effective === opts.panelNetwork) {
      // só a declaração do override do painel: externa, sem driver nem opções
      const extras = ["driver", "driver_opts", "internal", "attachable", "enable_ipv6", "labels"].filter((k) => cfg[k] !== undefined);
      if (isDict(cfg.ipam) && Object.keys(cfg.ipam).length > 0) extras.push("ipam");
      if (!isOn(cfg.external) || extras.length > 0) {
        out.push(
          finding(
            "network-hijack",
            "Rede do proxy do painel declarada de outro jeito",
            opts,
            undefined,
            `a rede "${key}" (${effective}) ${isOn(cfg.external) ? `traz ${extras.join(", ")}` : "não é externa"}`,
            "Não declare a rede do proxy no compose: o painel liga o serviço web a ela sozinho.",
          ),
        );
      }
      continue;
    }
    const owned = ownedByProject(effective, opts.projectName, key);
    const reasons: string[] = [];
    if (!owned && (isOn(cfg.external) || opts.projectName !== undefined)) {
      reasons.push(isOn(cfg.external) ? `é externa (${effective}) e não é do projeto` : `se chama "${effective}", fora do nome do projeto`);
    }
    if (cfg.driver !== undefined && !/^(bridge|overlay)?$/.test(str(cfg.driver))) reasons.push(`usa o driver "${str(cfg.driver)}"`);
    if (isDict(cfg.driver_opts) && Object.keys(cfg.driver_opts).length > 0) reasons.push("usa driver_opts");
    if (reasons.length > 0) {
      out.push(
        finding(
          "shared-resource",
          "Rede que não é do próprio projeto",
          opts,
          undefined,
          `a rede "${key}" ${reasons.join(" e ")}`,
          "Use apenas redes criadas pelo próprio compose (sem `external` nem `name:` de fora). O painel liga o serviço web à rede do proxy sozinho.",
        ),
      );
    }
  }

  for (const [kind, defs] of [["volume", model.volumes], ["rede", model.networks]] as const) {
    for (const [key, def] of Object.entries(isDict(defs) ? defs : {})) {
      const bad = reservedLabels(isDict(def) ? def.labels : undefined);
      if (bad.length > 0) {
        out.push(
          finding("reserved-name", "Label reservada do painel", opts, undefined, `${kind} "${key}" define a label ${bad.join(", ")}`, "Remova as labels `paas.*` e `com.docker.compose.*`: são do painel e do Compose."),
        );
      }
    }
  }

  for (const kind of ["secrets", "configs"] as const) {
    for (const [key, def] of Object.entries(isDict(model[kind]) ? model[kind] : {})) {
      const cfg = isDict(def) ? def : {};
      const file = str(cfg.file);
      if (isOn(cfg.external) || (file && !(raw && file.includes("$")) && !insideRoot(root, path.resolve(root, file)))) {
        out.push(
          finding(
            "build-outside-src",
            kind === "secrets" ? "Segredo lido de fora da pasta do projeto" : "Config lida de fora da pasta do projeto",
            opts,
            undefined,
            `${kind === "secrets" ? "o segredo" : "a config"} "${key}" usa ${file || "recurso externo"}`,
            "O arquivo precisa estar DENTRO do código do projeto.",
          ),
        );
      }
    }
  }
}

/**
 * Confere o modelo do compose (cru ou canônico) e devolve os bloqueios.
 * `model` é o resultado de `parse()` do YAML ou do JSON do `docker compose config`.
 */
export function checkComposeModel(model: unknown, opts: ComposeCheckOptions): GuardrailFinding[] {
  const out: GuardrailFinding[] = [];
  if (!isDict(model)) return out;
  const root = resolveRealPath(opts.srcRoot);
  const services = isDict(model.services) ? model.services : {};
  const topVolumes = isDict(model.volumes) ? model.volumes : {};
  const withNets = { ...opts, topNetworks: model.networks };
  for (const [name, service] of Object.entries(services)) {
    if (isDict(service)) checkService(name, service, services, topVolumes, withNets, root, out);
  }
  checkTopLevel(model, opts, root, out);
  return out;
}
