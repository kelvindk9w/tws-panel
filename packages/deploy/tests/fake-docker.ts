/** Docker simulado em memória (containers com estado, apelidos de rede e saúde) para os testes da troca sem queda. */
import type { DockerFn, DockerResult } from "../src/blue-green.js";

export interface Box {
  running: boolean;
  /** null = fora da rede do proxy do projeto (`FakeDocker.network`). */
  aliases: string[] | null;
  health?: string;
  exitCode?: number;
  ports?: Record<string, unknown[]>;
  mountSource?: string;
  /** Variáveis de ambiente do container (uma por linha). */
  env?: string;
  /** Status que ESTE container devolve à sonda (padrão: o `probeStatus` do FakeDocker). */
  probeStatus?: number | null;
  mounts?: Array<{ Type: string; Name?: string; RW: boolean; Destination: string }>;
}

export const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
export const bad = (stderr = "erro"): DockerResult => ({ code: 1, stdout: "", stderr });

export class FakeDocker {
  boxes = new Map<string, Box>();
  calls: string[][] = [];
  /** Status que o wget do Caddy enxerga na versão nova (null = sem resposta). */
  probeStatus: number | null = 200;
  /** Rede do proxy em que os apelidos valem (a do projeto de slug "loja", salvo o teste dizer outra). */
  network = "paas-proxy-loja";
  /** Falha dirigida: devolve o resultado para o comando, ou undefined para seguir normal. */
  /** Containers que a sonda atingiu, na ordem (um apelido com vários donos alterna entre eles, como o DNS do Docker). */
  probeHits: string[] = [];
  private rr = 0;
  failWhen: (args: string[]) => DockerResult | undefined = () => undefined;

  add(name: string, box: Partial<Box> = {}): void {
    this.boxes.set(name, { running: true, aliases: [name], ...box });
  }

  fn: DockerFn = async (args) => {
    this.calls.push(args);
    const forced = this.failWhen(args);
    if (forced) return forced;
    const [cmd] = args;
    if (cmd === "inspect") {
      const name = args[args.length - 1]!;
      const box = this.boxes.get(name);
      if (!box) return bad("No such object");
      if (args[1] === "-f") {
        if (args[2] === "{{.State.Running}}") return ok(`${box.running}\n`);
        if (args[2]!.includes("Mounts")) return ok(box.mountSource ?? "");
        if (args[2]!.includes("Config.Env")) return ok(box.env ?? "");
        return ok("id\n");
      }
      return ok(
        JSON.stringify([
          {
            State: { Running: box.running, Status: box.running ? "running" : "exited", ExitCode: box.exitCode ?? 0, ...(box.health ? { Health: { Status: box.health } } : {}) },
            HostConfig: { PortBindings: box.ports ?? {} },
            Mounts: box.mounts ?? [],
            NetworkSettings: { Networks: box.aliases === null ? {} : { [this.network]: { Aliases: box.aliases } } },
          },
        ]),
      );
    }
    if (cmd === "run") {
      const at = (flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
      const name = at("--name")[0]!;
      if (this.boxes.has(name)) return bad("name in use");
      this.boxes.set(name, { running: true, aliases: [...at("--network-alias"), name], mountSource: (at("-v")[0] ?? "").split(":")[0] ?? "" });
      return ok("cid\n");
    }
    if (cmd === "exec") {
      const host = /http:\/\/([^:/]+)/.exec(args[args.length - 1] ?? "")?.[1];
      const owners = host ? [...this.boxes.entries()].filter(([, b]) => b.running && b.aliases?.includes(host)) : [];
      if (owners.length > 0) {
        const [name, box] = owners[this.rr++ % owners.length]!;
        this.probeHits.push(name);
        const st = box.probeStatus !== undefined ? box.probeStatus : this.probeStatus;
        return { code: st === null ? 1 : 0, stdout: "", stderr: st === null ? "wget: can't connect" : `  HTTP/1.1 ${st} X\n` };
      }
    }
    if (cmd === "exec") return { code: this.probeStatus === null ? 1 : 0, stdout: "", stderr: this.probeStatus === null ? "wget: can't connect" : `  HTTP/1.1 ${this.probeStatus} X\n` };
    if (cmd === "rm") {
      this.boxes.delete(args[2]!);
      return ok();
    }
    if (cmd === "rename") {
      const box = this.boxes.get(args[1]!);
      if (!box) return bad("No such container");
      if (this.boxes.has(args[2]!)) return bad("name in use");
      this.boxes.delete(args[1]!);
      this.boxes.set(args[2]!, box);
      return ok();
    }
    if (cmd === "stop" || cmd === "start") {
      const box = this.boxes.get(args[1]!);
      if (!box) return bad("No such container");
      box.running = cmd === "start";
      return ok();
    }
    if (cmd === "network" && args[1] === "disconnect") {
      const box = this.boxes.get(args[3]!);
      if (box) box.aliases = null;
      return ok();
    }
    if (cmd === "network" && args[1] === "connect") {
      const box = this.boxes.get(args[args.length - 1]!);
      if (!box) return bad("No such container");
      const aliases: string[] = [];
      args.forEach((a, i) => a === "--alias" && aliases.push(args[i + 1]!));
      box.aliases = [...aliases, args[args.length - 1]!];
      return ok();
    }
    return ok();
  };

  ran(...prefix: string[]): boolean {
    return this.calls.some((c) => prefix.every((p, i) => c[i] === p));
  }
}

