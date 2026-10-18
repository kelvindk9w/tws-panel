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
import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { PAAS_MAIL_ADMIN_NETWORK, PAAS_MAIL_NETWORK, PAAS_PANEL_NETWORK, type GuardrailFinding } from "@paas/core";

/** Regras desta família que NENHUM override do operador libera (isolamento do painel). */
export const HARD_RULES: ReadonlySet<string> = new Set(["panel-image", "network-hijack", "reserved-name", "panel-resource"]);

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
  /** Rede de e-mail dos projetos (`paas-mail`): só os serviços de `mailServices` entram, sem aliases. */
  mailNetwork?: string;
  /** Serviços que o painel liga à rede de e-mail (projeto com e-mail habilitado). */
  mailServices?: readonly string[];
  /** Hosts que o servidor de e-mail responde (`mail.<domínio>`): nome de serviço da rede de e-mail não pode ser nenhum. */
  mailAliases?: readonly string[];
  /** Pastas do próprio painel (pasta de projetos e de instalação), da configuração: nenhum bind as alcança fora do código do projeto. */
  protectedPaths?: readonly string[];
  /** Redes internas do painel (painel↔Caddy, painel↔Stalwart): nenhum compose de projeto as toca. */
  restrictedNetworks?: readonly string[];
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
  readOnly: boolean;
}

function parseVolume(entry: unknown): VolumeEntry | null {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    if (parts.length < 2) return { type: "volume", source: "", target: entry, raw: entry, readOnly: false };
    const source = parts[0] ?? "";
    const named = !/^([./~]|[A-Za-z]:[\\/])/.test(source);
    const options = (parts[2] ?? "").split(",");
    return { type: named ? "volume" : "bind", source, target: parts[1] ?? "", raw: entry, readOnly: options.includes("ro") };
  }
  if (isDict(entry)) {
    const source = str(entry.source);
    return { type: str(entry.type) || (source.startsWith("/") || source.startsWith(".") ? "bind" : "volume"), source, target: str(entry.target), raw: JSON.stringify(entry), readOnly: isOn(entry.read_only) };
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


/**
 * LISTA FECHADA de chaves por nível. O Compose ganha campo novo a cada versão
 * (`use_api_socket`, `gpus`, `post_start`…) e cada um pode ser um caminho para
 * root: o que o painel não conhece BLOQUEIA (`unsupported-field`). Campos que
 * têm checagem própria estão na lista e são tratados nas funções abaixo.
 */
const SERVICE_KEYS: ReadonlySet<string> = new Set([
  "annotations", "attach", "blkio_config", "build", "cap_add", "cap_drop", "cgroup", "command", "configs",
  "container_name", "cpu_count", "cpu_percent", "cpu_period", "cpu_quota", "cpu_rt_period", "cpu_rt_runtime",
  "cpu_shares", "cpus", "cpuset", "depends_on", "deploy", "device_cgroup_rules", "devices", "dns", "dns_opt",
  "develop", "dns_search", "domainname", "entrypoint", "env_file", "environment", "expose", "extends", "external_links",
  "extra_hosts", "group_add", "healthcheck", "hostname", "image", "init", "ipc", "isolation", "labels", "links",
  "logging", "mac_address", "mem_limit", "mem_reservation", "mem_swappiness", "memswap_limit", "network_mode",
  "networks", "oom_kill_disable", "oom_score_adj", "pid", "pids_limit", "platform", "ports", "post_start",
  "pre_stop", "privileged", "profiles", "provider", "pull_policy", "read_only", "restart", "scale", "secrets",
  "security_opt", "shm_size", "stdin_open", "stop_grace_period", "stop_signal", "sysctls", "tmpfs", "tty",
  "ulimits", "user", "userns_mode", "uts", "volumes", "volumes_from", "working_dir",
]);
/** Campos que dão acesso ao host: sempre bloqueados quando ligados. */
const DANGEROUS_KEYS: Record<string, { rule: string; title: string; fix: string }> = {
  use_api_socket: { rule: "privileged-container", title: "Socket da API do Docker injetado (use_api_socket)", fix: "Remova `use_api_socket`: o Compose monta o docker.sock no container." },
  gpus: { rule: "privileged-container", title: "Acesso a GPU do host (gpus)", fix: "Remova `gpus`: expõe dispositivos do servidor ao container." },
  runtime: { rule: "privileged-container", title: "Runtime de container alternativo (runtime)", fix: "Remova `runtime`: runtimes como nvidia dão acesso a dispositivos do host." },
  cgroup_parent: { rule: "privileged-container", title: "cgroup do host (cgroup_parent)", fix: "Remova `cgroup_parent`: coloca o container no cgroup do sistema." },
  storage_opt: { rule: "privileged-container", title: "Opções de armazenamento do Docker (storage_opt)", fix: "Remova `storage_opt`." },
  credential_spec: { rule: "privileged-container", title: "Credenciais do host (credential_spec)", fix: "Remova `credential_spec`." },
  label_file: { rule: "host-mount", title: "Arquivo de labels lido do servidor (label_file)", fix: "Remova `label_file`: lê um arquivo qualquer do servidor." },
};
const HOOK_KEYS: ReadonlySet<string> = new Set(["command", "user", "privileged", "working_dir", "environment"]);
const DEPLOY_KEYS: ReadonlySet<string> = new Set(["replicas", "resources", "restart_policy", "labels", "mode", "update_config", "rollback_config", "placement", "endpoint_mode"]);
/**
 * Drivers de log aceitos e as opções de cada um (lista fechada). Nenhum driver de rede (gelf,
 * fluentd, awslogs, splunk, loki…) nem plugin. `syslog-address` e `syslog-tls-*` ficam de fora de
 * propósito: com tcp://, udp:// ou tcp+tls:// o daemon manda os logs do projeto (e os segredos que
 * passam por eles) para fora da VPS, e um caminho unix:// escolhido pelo projeto não teria ganho
 * (o padrão do driver já é o /dev/log local).
 */
const LOG_COMMON = ["labels", "labels-regex", "env", "env-regex"];
const LOGGING_DRIVERS: Readonly<Record<string, ReadonlySet<string>>> = {
  "json-file": new Set(["max-size", "max-file", "compress", "tag", ...LOG_COMMON]),
  local: new Set(["max-size", "max-file", "compress"]),
  none: new Set(),
  journald: new Set(["tag", ...LOG_COMMON]),
  syslog: new Set(["tag", "facility", "syslog-format", ...LOG_COMMON]),
};
const TOP_KEYS: ReadonlySet<string> = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);

function checkKeys(name: string, service: Dict, opts: ComposeCheckOptions, out: GuardrailFinding[]): void {
  const raw = opts.mode === "raw";
  const unresolved = (value: unknown) => raw && typeof value === "string" && value.includes("$");
  const unknown = (where: string, key: string) =>
    out.push(
      finding(
        "unsupported-field",
        "Campo do compose que o painel não conhece",
        opts,
        name,
        `usa ${where}${key}, que não está na lista de campos aceitos`,
        "Remova o campo. O painel só aceita os campos que sabe que não dão acesso ao servidor; um campo novo do Compose precisa ser avaliado antes de entrar.",
      ),
    );

  for (const key of Object.keys(service)) {
    if (key.startsWith("x-")) continue;
    const danger = DANGEROUS_KEYS[key];
    if (danger) {
      const value = service[key];
      const on = Array.isArray(value) ? value.length > 0 : isDict(value) ? Object.keys(value).length > 0 : isOn(value);
      if (on && !unresolved(value)) out.push(finding(danger.rule, danger.title, opts, name, `define ${key}`, danger.fix));
      continue;
    }
    if (!SERVICE_KEYS.has(key) && key !== "pre_start") unknown("", key);
  }
  if (service.pre_start !== undefined) unknown("", "pre_start");

  // ganchos: o mesmo rigor, por recursão (um gancho `privileged` é root no host)
  for (const hook of ["post_start", "pre_stop", "pre_start"]) {
    for (const entry of asList(service[hook])) {
      if (!isDict(entry)) continue;
      for (const key of Object.keys(entry)) {
        if (!HOOK_KEYS.has(key)) unknown(`${hook}.`, key);
      }
      if (!unresolved(entry.privileged) && isOn(entry.privileged)) {
        out.push(
          finding("privileged-container", "Gancho privilegiado", opts, name, `${hook} define privileged: ${str(entry.privileged)}`, `Remova \`privileged\` do ${hook}: equivale a root no host.`),
        );
      }
    }
  }

  const deploy = service.deploy;
  if (isDict(deploy)) {
    for (const key of Object.keys(deploy)) if (!DEPLOY_KEYS.has(key) && !key.startsWith("x-")) unknown("deploy.", key);
    const resources = deploy.resources;
    if (isDict(resources)) {
      for (const key of Object.keys(resources)) if (key !== "limits" && key !== "reservations" && !key.startsWith("x-")) unknown("deploy.resources.", key);
      if (isDict(resources.limits)) {
        for (const key of Object.keys(resources.limits)) if (!["cpus", "memory", "pids"].includes(key)) unknown("deploy.resources.limits.", key);
      }
      if (isDict(resources.reservations)) {
        for (const key of Object.keys(resources.reservations)) {
          if (key === "devices") {
            if (asList(resources.reservations.devices).length > 0) {
              out.push(
                finding("privileged-container", "Acesso a dispositivos do host (deploy.resources.reservations.devices)", opts, name, "reserva devices (GPU etc.)", "Remova `deploy.resources.reservations.devices`: expõe dispositivos do servidor ao container."),
              );
            }
          } else if (!["cpus", "memory"].includes(key)) {
            unknown("deploy.resources.reservations.", key);
          }
        }
      }
    }
  }
  const driver = isDict(service.logging) ? str(service.logging.driver) : "";
  if (driver && !unresolved(driver) && !Object.hasOwn(LOGGING_DRIVERS, driver)) {
    unknown("logging.driver: ", driver);
  } else if (isDict(service.logging) && isDict(service.logging.options) && !unresolved(driver)) {
    const allowed = LOGGING_DRIVERS[driver || "json-file"]!;
    for (const key of Object.keys(service.logging.options)) {
      if (!allowed.has(key)) unknown(`logging.options (driver ${driver || "json-file"}): `, key);
    }
  }
}

/** Caminho do socket do Docker em qualquer grafia (`//var//run/../run/docker.sock`, `/proc/self/root/…`, maiúsculas). */
function isDockerSocket(source: string): boolean {
  const normal = path.posix.normalize(source.trim().toLowerCase()).replace(/\/+$/, "");
  return /(^|\/)docker\.sock$/.test(normal);
}

/** Caminho absoluto normalizado (`//`, `..` e barra final resolvidos), em minúsculas. */
function cleanHostPath(p: string): string {
  const n = path.posix.normalize(p.trim().toLowerCase()).replace(/\/+$/, "");
  return n === "" ? "/" : n;
}

/** Mesmo caminho, sem o prefixo `/proc/<pid>/root` (que é o próprio `/`). */
function normalizeHostPath(p: string): string {
  const n = cleanHostPath(p).replace(/^\/proc\/[^/]+\/root(?=\/|$)/, "");
  return n === "" ? "/" : n;
}

/** Sockets de controle do host em /run e /var/run (docker, containerd, crio, podman…) e as pastas deles. */
const RUN_SOCKET = /^\/(var\/)?run\/(.*\/)?[^/]*\.sock$/;
const RUN_CONTROL_DIRS = /^\/(var\/)?run\/(containerd|docker|podman|crio|buildkit)(\/|$)/;

/**
 * O caminho É o socket do Docker, CONTÉM o socket (`/`, `/run`, `/var`, `/var/run`), é a pasta de
 * dados do Docker (`/var/lib/docker…`, onde moram os volumes do painel), o /data do painel,
 * `/proc` (`/proc/1/root` é a raiz do host) ou `/sys` (`uevent_helper` executa como root), um
 * socket de controle em /run, ou uma das pastas do próprio painel que vêm da configuração
 * (`protectedPaths`: a pasta de projetos e a de instalação), dentro ou acima.
 * `insideSrc`: o código do próprio projeto vive dentro de /data/projects e da pasta de projetos;
 * dentro dele nada disso conta.
 */
function touchesPanelHost(p: string, insideSrc: boolean, protectedPaths: readonly string[] = []): boolean {
  if (!p.startsWith("/") && !p.startsWith("\\")) return false;
  const raw = cleanHostPath(p);
  if (raw === "/proc" || raw.startsWith("/proc/") || raw === "/sys" || raw.startsWith("/sys/")) {
    // /proc/<pid>/root é a raiz: o que vem depois é avaliado abaixo, mas o próprio /proc/…/root já é o host
    return true;
  }
  const n = normalizeHostPath(p);
  if (isDockerSocket(n) || ["/", "/run", "/var", "/var/run", "/var/lib"].includes(n)) return true;
  if (RUN_SOCKET.test(n) || RUN_CONTROL_DIRS.test(n)) return true;
  if (n === "/var/lib/docker" || n.startsWith("/var/lib/docker/")) return true;
  if (insideSrc) return false;
  if (n === "/data" || n.startsWith("/data/")) return true;
  return protectedPaths.some((prot) => {
    const base = cleanHostPath(prot);
    return base !== "/" && (n === base || n.startsWith(base + "/") || base.startsWith(n + "/"));
  });
}

/** O caminho (ou um link no caminho) leva ao socket, à pasta do Docker ou ao /data do painel? Segue links mesmo que o destino não exista aqui. */
function pointsToPanelHost(source: string, root: string, protectedPaths: readonly string[] = []): boolean {
  const inside = (abs: string) => abs === root || abs.startsWith(root + path.sep);
  if (touchesPanelHost(source, source.startsWith("/") && inside(path.resolve(source)), protectedPaths)) return true;
  let current = path.resolve(root, source);
  for (let i = 0; i < 8; i++) {
    let target: string;
    try {
      target = readlinkSync(current);
    } catch {
      break;
    }
    const abs = path.resolve(path.dirname(current), target);
    if (touchesPanelHost(abs, inside(abs), protectedPaths)) return true;
    current = abs;
  }
  const real = resolveRealPath(path.resolve(root, source));
  return touchesPanelHost(real, inside(real), protectedPaths);
}

/** Nome do espaço do painel: `paas-*`, `paas_*`, `tws-*` e os nomes reservados. */
function inPanelNamespace(name: string): boolean {
  const n = name.trim().toLowerCase();
  return RESERVED_NAMES.includes(n) || /^(paas|tws)[-_]/.test(n);
}

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
    if (vol.type === "bind" && vol.source && pointsToPanelHost(vol.source, root, opts.protectedPaths)) {
      out.push(
        finding(
          "panel-resource",
          "Socket do Docker montado no container",
          opts,
          name,
          `monta ${vol.source}, que é (ou contém) o socket do Docker, a pasta de dados do Docker ou os dados do painel`,
          "Remova a montagem: dá controle total sobre o servidor (docker.sock, volumes do Docker, /data do painel) e não pode ser liberada.",
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

  checkKeys(name, service, opts, out);
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

  const bad = [...reservedLabels(service.labels), ...reservedLabels(isDict(service.deploy) ? service.deploy.labels : undefined)];
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
    if ((opts.restrictedNetworks ?? []).includes(effective)) {
      out.push(
        finding("network-hijack", "Rede interna do painel", opts, name, `entra na rede ${effective}, que é só do painel`, "Remova a rede do serviço: ela liga o painel ao Caddy e ao servidor de e-mail."),
      );
    } else if (opts.mailNetwork !== undefined && effective === opts.mailNetwork) {
      if (!(opts.mailServices ?? []).includes(name)) {
        out.push(
          finding("network-hijack", "Serviço ligado à rede de e-mail do painel", opts, name, `entra na rede ${effective}, que só o painel liga (a projetos com e-mail habilitado)`, "Remova a rede do serviço: o painel liga os serviços do projeto a ela quando o e-mail está habilitado."),
        );
      } else if (aliases.length > 0) {
        out.push(
          finding("network-hijack", "Alias na rede de e-mail do painel", opts, name, `define aliases ${aliases.join(", ")} na rede ${effective}`, "Remova os aliases: um alias desviaria o tráfego do servidor de e-mail para este container."),
        );
      }
    } else if (opts.panelNetwork !== undefined && effective === opts.panelNetwork) {
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

  // rede de e-mail: o nome do serviço, o container_name, o hostname e os aliases viram nomes no DNS
  // dela (onde moram o Stalwart e o webmail), em TODAS as redes do serviço
  if ((opts.mailServices ?? []).includes(name)) {
    const mailAliases = (opts.mailAliases ?? []).map((a) => a.toLowerCase());
    const taken = (value: string) => {
      const n = value.trim().toLowerCase();
      return n !== "" && (isReservedName(n, opts, name) || n.startsWith("mail.") || mailAliases.includes(n));
    };
    const candidates: Array<[string, string]> = [
      ["tem o nome de serviço", name],
      ["usa container_name", containerName],
      ["usa hostname", str(service.hostname)],
      ...attached.flatMap(([key, cfg]) => (isDict(cfg) ? asList(cfg.aliases) : []).map((a) => [`define o alias (rede ${key})`, str(a)] as [string, string])),
    ];
    for (const [what, value] of candidates) {
      if (!value || skip(value) || !taken(value)) continue;
      out.push(
        finding("network-hijack", "Nome reservado na rede de e-mail do painel", opts, name, `${what} "${value}" na rede de e-mail`, "Escolha outro nome: na rede de e-mail ele responderia no lugar do servidor de e-mail, do webmail ou de outro projeto."),
      );
    }
  }

  // imagem: um build não pode regravar a tag de imagem do painel, e imagem de outro projeto não se reutiliza
  const build = service.build;
  const image = str(service.image);
  const tags = isDict(build) ? asList(build.tags).map(str) : [];
  const protectedRepos = new Set((opts.protectedImages ?? []).filter((r) => typeof r === "string" && r !== "").map(imageRepository));
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

/** Chaves aceitas em `build` (as que dão acesso ao host têm checagem própria abaixo). */
const BUILD_KEYS: ReadonlySet<string> = new Set([
  "context", "dockerfile", "dockerfile_inline", "args", "labels", "cache_from", "cache_to", "no_cache", "additional_contexts",
  "network", "pull", "target", "shm_size", "extra_hosts", "isolation", "privileged", "secrets", "tags", "ulimits",
  "platforms", "entitlements", "ssh", "provenance", "sbom",
]);

/** Campos de um CSV (RFC 4180: aspas protegem vírgulas e `""` é uma aspa), como o buildx lê o cache. */
function csvFields(text: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') quoted = false;
      else current += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      fields.push(current);
      current = "";
    } else current += c;
  }
  fields.push(current);
  return fields;
}

/**
 * Cache de build só em registro (ou embutido na imagem): `local` grava e lê pastas que o painel
 * alcança (o /data dele, o src de outro projeto). O buildx lê a entrada como CSV e baixa as
 * chaves (`Type=`, `Dest=`, aspas por campo valem): a conferência faz o mesmo. Aceita referência
 * de imagem sem `=`, ou entrada cujo tipo seja exatamente `registry` ou `inline`; qualquer
 * `src`/`dest` ou outro tipo (local, gha, s3, azblob…) é recusado.
 */
function badCacheEntry(entry: unknown): boolean {
  let pairs: Array<[string, string]>;
  if (isDict(entry)) {
    pairs = Object.entries(entry).map(([k, v]) => [k.trim().toLowerCase(), str(v).trim()]);
  } else {
    const text = str(entry);
    if (!text.includes("=")) return false; // referência de imagem
    pairs = csvFields(text).map((field) => {
      const at = field.indexOf("=");
      return at < 0 ? [field.trim().toLowerCase(), ""] : [field.slice(0, at).trim().toLowerCase(), field.slice(at + 1).trim()];
    });
  }
  const keys = pairs.map(([k]) => k);
  // chave repetida: o buildx fica com a ÚLTIMA (type=registry,…,type=local grava em disco); recusa-se qualquer repetição
  if (new Set(keys).size !== keys.length) return true;
  if (keys.includes("src") || keys.includes("dest")) return true;
  const type = [...pairs].reverse().find(([k]) => k === "type")?.[1];
  return type !== "registry" && type !== "inline";
}

function checkBuild(name: string, service: Dict, opts: ComposeCheckOptions, root: string, out: GuardrailFinding[]): void {
  const build = service.build;
  if (build === undefined || build === null) return;
  const raw = opts.mode === "raw";
  const unresolved = (value: unknown) => raw && typeof value === "string" && value.includes("$");
  const cfg: Dict = isDict(build) ? build : { context: build };
  for (const key of Object.keys(cfg)) {
    if (!BUILD_KEYS.has(key) && !key.startsWith("x-")) {
      out.push(
        finding("unsupported-field", "Campo do compose que o painel não conhece", opts, name, `usa build.${key}, que não está na lista de campos aceitos`, "Remova o campo. O painel só aceita os campos de build que sabe que não dão acesso ao servidor."),
      );
    }
  }
  for (const field of ["cache_from", "cache_to"] as const) {
    const bad = asList(cfg[field]).filter((e) => !(typeof e === "string" && unresolved(e)) && badCacheEntry(e));
    if (bad.length > 0) {
      out.push(
        finding(
          "build-outside-src",
          "Cache de build em pasta do servidor",
          opts,
          name,
          `build.${field} usa ${bad.map((e) => (isDict(e) ? JSON.stringify(e) : str(e))).join(", ")}`,
          "Use cache em registro (type=registry) ou embutido (type=inline). Cache local lê e grava pastas do servidor, inclusive os dados do painel.",
        ),
      );
    }
  }
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
    if (!owned && inPanelNamespace(effective)) {
      out.push(
        finding("panel-resource", "Volume do painel ou de outro projeto", opts, undefined, `o volume "${key}" usa "${effective}", que é do painel ou de outro projeto`, "Esse volume guarda dados do painel (banco, certificados, e-mails) ou de outro projeto e não pode ser usado. Declare um volume com outro nome."),
      );
    } else if (!owned && (isOn(cfg.external) || opts.projectName !== undefined)) {
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
    if ((opts.restrictedNetworks ?? []).includes(effective)) {
      out.push(
        finding("network-hijack", "Rede interna do painel declarada no compose", opts, undefined, `a rede "${key}" (${effective}) é só do painel`, "Não declare essa rede: ela liga o painel ao Caddy e ao servidor de e-mail."),
      );
      continue;
    }
    // a rede do proxy e a de e-mail, do jeito que o override do painel as declara
    const mailNet = opts.mailNetwork !== undefined && effective === opts.mailNetwork;
    if (mailNet && (opts.mailServices ?? []).length === 0) {
      out.push(
        finding("network-hijack", "Rede de e-mail do painel declarada no compose", opts, undefined, `a rede "${key}" (${effective}) só é ligada pelo painel, em projetos com e-mail habilitado`, "Não declare essa rede."),
      );
      continue;
    }
    if (mailNet || (opts.panelNetwork !== undefined && effective === opts.panelNetwork)) {
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
    if (!owned && inPanelNamespace(effective)) {
      out.push(
        finding("panel-resource", "Rede do painel ou de outro projeto", opts, undefined, `a rede "${key}" usa "${effective}", que é do painel ou de outro projeto`, "Não use redes do painel nem de outros projetos: elas dariam acesso aos containers deles."),
      );
    } else if (!owned && (isOn(cfg.external) || opts.projectName !== undefined)) {
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
 * Um bind DENTRO de outro bind gravável deixa o app trocar a subpasta por um
 * link (ex.: `./:/app` + `./dados:/data`, e o app faz `src/dados -> /`): o
 * Docker segue o link a CADA start do container, não só no deploy. O pai só
 * pode conter outro bind se for somente leitura.
 */
function checkNestedBinds(model: Dict, services: Dict, opts: ComposeCheckOptions, root: string, out: GuardrailFinding[]): void {
  const raw = opts.mode === "raw";
  interface Bind { service: string; path: string; source: string; readOnly: boolean }
  const binds: Bind[] = [];
  for (const [service, def] of Object.entries(services)) {
    if (!isDict(def)) continue;
    for (const entry of asList(def.volumes)) {
      const vol = parseVolume(entry);
      if (!vol || vol.type !== "bind" || !vol.source || vol.source.startsWith("~")) continue;
      if (raw && (vol.source.includes("$") || vol.raw.includes("$"))) continue;
      const abs = path.resolve(root, vol.source);
      // o último componente NÃO é seguido: é ele que o app pode trocar por um link
      const canonicalPath = path.join(resolveRealPath(path.dirname(abs)), path.basename(abs));
      // bind fora do código do projeto já é barrado por si só (host-mount / panel-resource)
      if (canonicalPath !== root && !canonicalPath.startsWith(root + path.sep)) continue;
      binds.push({ service, path: canonicalPath, source: vol.source, readOnly: vol.readOnly });
    }
  }
  // o mesmo vale para o que o PAINEL lê: contexto de build, Dockerfile, env_file, secrets e configs
  // dentro de um bind gravável (o app alterna a pasta com um link para /data entre a conferência e o build)
  interface Read { service?: string; path: string; what: string; value: string }
  const reads: Read[] = [];
  const canonical = (value: string): string => {
    const target = path.resolve(root, value);
    return path.join(resolveRealPath(path.dirname(target)), path.basename(target));
  };
  const skip = (value: string) => value === "" || value.startsWith("~") || (raw && value.includes("$"));
  const add = (service: string | undefined, what: string, value: string, base = root) => {
    if (skip(value)) return;
    const target = path.resolve(base, value);
    reads.push({ ...(service ? { service } : {}), path: canonical(target), what, value });
  };
  for (const [service, def] of Object.entries(services)) {
    if (!isDict(def)) continue;
    const build = def.build;
    if (build !== undefined && build !== null) {
      const cfg: Dict = isDict(build) ? build : { context: build };
      const context = str(cfg.context) || ".";
      const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(context) || /^git@/.test(context);
      if (!remote) {
        add(service, "o contexto de build", context);
        if (typeof cfg.dockerfile === "string") add(service, "o Dockerfile", cfg.dockerfile, path.resolve(root, context));
      }
      const extra: Array<unknown> = Array.isArray(cfg.additional_contexts)
        ? cfg.additional_contexts.map((e) => str(e).slice(str(e).indexOf("=") + 1))
        : isDict(cfg.additional_contexts)
          ? Object.values(cfg.additional_contexts)
          : [];
      for (const value of extra.map(str)) {
        if (/^(docker-image|service|target|oci-layout):/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
        add(service, "um contexto adicional do build", value);
      }
    }
    for (const entry of asList(def.env_file)) add(service, "o env_file", isDict(entry) ? str(entry.path) : str(entry));
  }
  for (const kind of ["secrets", "configs"] as const) {
    for (const [key, d] of Object.entries(isDict(model[kind]) ? model[kind] : {})) {
      if (isDict(d) && typeof d.file === "string") add(undefined, `${kind === "secrets" ? "o segredo" : "a config"} "${key}"`, d.file);
    }
  }
  for (const read of reads) {
    const parent = binds.find((b) => !b.readOnly && read.path !== b.path && read.path.startsWith(b.path.endsWith(path.sep) ? b.path : b.path + path.sep));
    if (!parent) continue;
    out.push(
      finding(
        "host-mount",
        "Arquivo lido pelo painel dentro de uma pasta montada com escrita",
        opts,
        read.service,
        `${read.what} ${read.value} fica dentro de ${parent.source} (serviço "${parent.service}"), montada com escrita`,
        "O app pode trocar essa pasta por um link para qualquer lugar do servidor (como o /data do painel) e o painel o leria no build. Monte a pasta de cima como somente leitura (:ro) ou mova o arquivo para fora dela.",
      ),
    );
  }
  const seen = new Set<string>();
  for (const inner of binds) {
    const parent = binds.find((b) => !b.readOnly && b.path !== inner.path && inner.path.startsWith(b.path.endsWith(path.sep) ? b.path : b.path + path.sep));
    if (!parent) continue;
    const key = `${inner.service}:${inner.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      finding(
        "host-mount",
        "Pasta montada dentro de outra pasta montada com escrita",
        opts,
        inner.service,
        `monta ${inner.source}, que fica dentro de ${parent.source} (serviço "${parent.service}"), montada com escrita`,
        "O app pode trocar a subpasta por um link para qualquer lugar do servidor e o Docker o seguiria. Monte a pasta de cima como somente leitura (:ro) ou separe as pastas.",
      ),
    );
  }
}

/**
 * Confere o modelo do compose (cru ou canônico) e devolve os bloqueios.
 * `model` é o resultado de `parse()` do YAML ou do JSON do `docker compose config`.
 */
export function checkComposeModel(given: unknown, options: ComposeCheckOptions): GuardrailFinding[] {
  const model = given;
  // As redes internas do painel são reservadas em TODA checagem, com ou sem contexto de projeto.
  const opts: ComposeCheckOptions = {
    restrictedNetworks: [PAAS_PANEL_NETWORK, PAAS_MAIL_ADMIN_NETWORK],
    mailNetwork: PAAS_MAIL_NETWORK,
    ...options,
  };
  const out: GuardrailFinding[] = [];
  if (!isDict(model)) return out;
  const root = resolveRealPath(opts.srcRoot);
  const services = isDict(model.services) ? model.services : {};
  const topVolumes = isDict(model.volumes) ? model.volumes : {};
  const withNets = { ...opts, topNetworks: model.networks };
  for (const [name, service] of Object.entries(services)) {
    if (isDict(service)) checkService(name, service, services, topVolumes, withNets, root, out);
  }
  checkNestedBinds(model, services, withNets, root, out);
  checkTopLevel(model, opts, root, out);
  for (const key of Object.keys(model)) {
    if (key.startsWith("x-") || TOP_KEYS.has(key) || (opts.mode === "raw" && (key === "version" || key === "include"))) continue;
    out.push(
      finding("unsupported-field", "Campo do compose que o painel não conhece", opts, undefined, `usa ${key} no topo do arquivo, que não está na lista de campos aceitos`, "Remova o campo: o painel só aceita name, services, networks, volumes, secrets e configs."),
    );
  }
  return out;
}
