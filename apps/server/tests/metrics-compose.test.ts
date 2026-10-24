/**
 * metrics-compose.test.ts — as montagens do host que o monitoramento de
 * recursos exige: somente leitura, nos caminhos que a configuração espera, e
 * nada além disso (cada montagem nova no compose do painel é uma decisão de
 * segurança, documentada em SECURITY.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const root = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

function mounts(): string[] {
  const out: string[] = [];
  let inVolumes = false;
  for (const raw of read("docker-compose.yml").split("\n")) {
    if (/^    volumes:\s*$/.test(raw)) {
      inVolumes = true;
      continue;
    }
    if (inVolumes && /^    \S/.test(raw)) break;
    const m = /^      - (\S+)\s*$/.exec(raw);
    if (inVolumes && m) out.push(m[1]!);
  }
  return out;
}

describe("montagens do compose do painel", () => {
  it("/proc e /sys/fs/cgroup do host, SOMENTE LEITURA, onde a configuração padrão espera", () => {
    const m = mounts();
    expect(m).toContain("/proc:/host/proc:ro");
    expect(m).toContain("/sys/fs/cgroup:/host/sys/fs/cgroup:ro");
    const cfg = loadConfig().metrics!;
    expect(cfg.hostProc).toBe("/host/proc");
    expect(cfg.hostCgroup).toBe("/host/sys/fs/cgroup");
  });

  it("toda montagem do host que não é a pasta de projetos nem o socket é somente leitura", () => {
    for (const mount of mounts()) {
      if (mount.startsWith("/var/run/docker.sock") || mount.startsWith("${PAAS_PROJECTS_DIR") || mount.startsWith("paas_data:")) continue;
      expect(mount, mount).toMatch(/:ro$/);
    }
  });

  it("a lista de montagens é exatamente a conhecida (montagem nova exige revisar este teste e o SECURITY.md)", () => {
    expect(mounts().map((m) => m.replace(/:ro$/, "")).sort()).toEqual(
      [
        "${PAAS_PROJECTS_DIR:-/opt/tws-projects}:${PAAS_PROJECTS_DIR:-/opt/tws-projects}",
        "/etc/hostname:/host/etc/hostname",
        "/etc/localtime:/host/etc/localtime",
        "/etc/os-release:/host/etc/os-release",
        "/proc:/host/proc",
        "/sys/fs/cgroup:/host/sys/fs/cgroup",
        "/var/run/docker.sock:/var/run/docker.sock",
        "paas_data:/data",
      ].sort(),
    );
  });

  it("o instalador e o SECURITY.md falam das montagens", () => {
    expect(read("scripts/install.sh")).toContain("/sys/fs/cgroup");
    expect(read("SECURITY.md")).toContain("/host/proc");
  });
});
