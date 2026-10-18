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

/** Volume do próprio projeto: o nome efetivo começa com o nome do projeto no compose. */
function ownedByProject(name: string, projectName: string | undefined): boolean {
  return projectName !== undefined && (name.startsWith(`${projectName}_`) || name.startsWith(`${projectName}-`));
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
    const owned = ownedByProject(effective, opts.projectName);
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
    if (opts.panelNetwork !== undefined && effective === opts.panelNetwork && isOn(cfg.external)) continue;
    const owned = ownedByProject(effective, opts.projectName);
    const reasons: string[] = [];
    if (!owned && (isOn(cfg.external) || (opts.projectName !== undefined && key !== "default"))) {
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
  for (const [name, service] of Object.entries(services)) {
    if (isDict(service)) checkService(name, service, services, topVolumes, opts, root, out);
  }
  checkTopLevel(model, opts, root, out);
  return out;
}
