import { describe, expect, it } from "vitest";
import type { ProjectLogService } from "@paas/core";
import { buildServerLogsQuery, hasJournalUnavailable, isJournalSource, isSourceId, serverLogsErrorKey, sourceLabelKey } from "../src/lib/server-logs";

const svc = (service: string, logsError: ProjectLogService["logsError"]): ProjectLogService => ({
  service,
  container: "",
  state: "journal",
  status: "",
  health: null,
  restartCount: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  logsError,
});

describe("lib/server-logs", () => {
  it("reconhece as fontes e as do journal", () => {
    expect(isSourceId("ssh")).toBe(true);
    expect(isSourceId("x")).toBe(false);
    expect(isJournalSource("docker")).toBe(true);
    expect(isJournalSource("panel")).toBe(false);
    expect(sourceLabelKey("mail")).toBe("diagnostico.serverLogs.source.mail");
    expect(sourceLabelKey("x")).toBeNull();
  });

  it("monta a query só com o que foi escolhido", () => {
    expect(buildServerLogsQuery({ source: "", tail: 200, since: "" })).toBe("tail=200");
    expect(buildServerLogsQuery({ source: "mail", tail: 500, since: "24h" })).toBe("tail=500&source=mail&since=24h");
  });

  it("traduz o código de erro; 429 sem código vira o do limitador", () => {
    expect(serverLogsErrorKey("docker_unavailable", 503)).toContain("docker");
    expect(serverLogsErrorKey("log_masking_unavailable", 503)).toContain("masking");
    expect(serverLogsErrorKey("logs_busy", 429)).toContain("busy");
    expect(serverLogsErrorKey("source_not_found", 404)).toContain("notFound");
    expect(serverLogsErrorKey("invalid_source", 400)).toContain("invalid");
    expect(serverLogsErrorKey("", 429)).toContain("rate");
    expect(serverLogsErrorKey("", 500)).toContain("load");
  });

  it("só considera indisponível a fonte do journal com logsError unavailable", () => {
    expect(hasJournalUnavailable([svc("ssh", "unavailable")])).toBe(true);
    expect(hasJournalUnavailable([svc("panel", "unavailable")])).toBe(false);
    expect(hasJournalUnavailable([svc("ssh", null)])).toBe(false);
  });
});
