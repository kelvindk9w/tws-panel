/**
 * Leitura do journal da VPS (host-journal.ts): comando montado só com unidades fixas, allowlist estrita
 * (recompõe e compara byte a byte) e interpretação da saída. Tudo puro (sem systemd).
 */
import { describe, expect, it } from "vitest";
import {
  JOURNAL_LINES_MAX,
  buildJournalCommand,
  isJournalCommand,
  isJournalSource,
  journalTimestamp,
  parseJournalOutput,
} from "../src/host-journal.js";
import { isAllowedHostCommand } from "../src/host-bridge.js";

const REMOTE_DIR = "/opt/paas-hardening";

describe("buildJournalCommand", () => {
  it("usa só unidades fixas e corta linhas enormes no host", () => {
    expect(buildJournalCommand("docker", 200, null)).toBe(
      "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 200 | cut -c1-4000",
    );
    expect(buildJournalCommand("ssh", 50, 1_790_000_000)).toBe(
      "journalctl -u ssh.service -u sshd.service --no-pager -q -o short-iso --utc -n 50 --since '2026-09-21 14:13:20 UTC' | cut -c1-4000",
    );
  });

  it("recusa fonte, linhas e início inválidos", () => {
    expect(() => buildJournalCommand("cron" as never, 10, null)).toThrow(/fonte/);
    for (const n of [0, -1, 1.5, JOURNAL_LINES_MAX + 1, Number.NaN]) {
      expect(() => buildJournalCommand("docker", n, null)).toThrow(/linhas/);
    }
    for (const s of [5, 1.5, 10_000_000_000, Number.NaN]) {
      expect(() => buildJournalCommand("docker", 10, s)).toThrow(/janela/);
    }
  });

  it("formata a data em UTC com zeros à esquerda", () => {
    expect(journalTimestamp(1_000_000_000)).toBe("2001-09-09 01:46:40 UTC");
  });
});

describe("isJournalSource", () => {
  it("só docker e ssh", () => {
    expect(isJournalSource("docker")).toBe(true);
    expect(isJournalSource("ssh")).toBe(true);
    expect(isJournalSource("sshd")).toBe(false);
    expect(isJournalSource("toString")).toBe(false);
  });
});

describe("allowlist do host bridge", () => {
  it("aceita o que o construtor monta, com e sem janela", () => {
    for (const source of ["docker", "ssh"] as const) {
      for (const since of [null, 1_790_000_000]) {
        const cmd = buildJournalCommand(source, 123, since);
        expect(isJournalCommand(cmd)).toBe(true);
        expect(isAllowedHostCommand(cmd, REMOTE_DIR)).toBe(true);
      }
    }
  });

  it.each([
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 200 | cut -c1-4000; id",
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 200 | sh",
    "journalctl -u cron.service --no-pager -q -o short-iso --utc -n 200 | cut -c1-4000",
    "journalctl -u docker.service -u ssh.service --no-pager -q -o short-iso --utc -n 200 | cut -c1-4000",
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 9999 | cut -c1-4000",
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 0200 | cut -c1-4000",
    "journalctl -u docker.service --no-pager -q -o json --utc -n 200 | cut -c1-4000",
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 200 --since '2026-09-21 14:13:20 UTC' $(id) | cut -c1-4000",
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 200 --since '1999-01-01 00:00:00 UTC' | cut -c1-4000",
    "journalctl -u docker.service --no-pager -q -o short-iso --utc -n 200 --since '2026-13-45 99:99:99 UTC' | cut -c1-4000",
    "journalctl -f",
    "",
  ])("nega %j", (cmd) => {
    expect(isJournalCommand(cmd)).toBe(false);
    expect(isAllowedHostCommand(cmd, REMOTE_DIR)).toBe(false);
  });
});

describe("parseJournalOutput", () => {
  const out = [
    "2026-10-30T10:00:01+0000 vps dockerd[812]: time=\"2026-10-30T10:00:01Z\" level=info msg=\"ok\"",
    "2026-10-30T10:00:02.123456+00:00 vps sshd[900]: Failed password for invalid user admin from 203.0.113.9 port 4000 ssh2",
    "continuação sem horário",
    "-- Boot abc --",
    "",
    "2026-99-99T10:00:02+0000 vps x: data impossível",
  ].join("\n");

  it("lê horário (UTC), texto e continuações; ignora cabeçalhos e vazias", () => {
    const lines = parseJournalOutput(out);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ time: "2026-10-30T10:00:01.000Z", text: 'vps dockerd[812]: time="2026-10-30T10:00:01Z" level=info msg="ok"' });
    expect(lines[1]!.time).toBe("2026-10-30T10:00:02.123Z");
    expect(lines[1]!.text).toContain("Failed password");
    expect(lines[2]).toEqual({ time: null, text: "continuação sem horário" });
    expect(lines[3]!.time).toBeNull();
  });

  it("aceita CRLF e saída vazia", () => {
    expect(parseJournalOutput("")).toEqual([]);
    expect(parseJournalOutput("2026-10-30T10:00:01Z vps a: b\r\n")[0]!.text).toBe("vps a: b");
  });
});
