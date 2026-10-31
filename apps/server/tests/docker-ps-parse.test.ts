/**
 * Leitura do `docker ps -a --format json`: além do estado, o serviço do
 * compose (label com.docker.compose.service) e a saúde (healthcheck) de cada
 * container — a Visão geral mostra "rodando, saudável / não saudável /
 * parado / reiniciando" por serviço do compose depois do deploy.
 */
import { describe, expect, it } from "vitest";
import { containersFromPs, healthFromStatus } from "../src/services/docker-service.js";

describe("healthFromStatus", () => {
  it("lê a saúde do texto de status do docker ps", () => {
    expect(healthFromStatus("Up 5 minutes (healthy)")).toBe("healthy");
    expect(healthFromStatus("Up 2 minutes (unhealthy)")).toBe("unhealthy");
    expect(healthFromStatus("Up 3 seconds (health: starting)")).toBe("starting");
    expect(healthFromStatus("Up 1 hour")).toBeNull();
    expect(healthFromStatus("Exited (1) 2 minutes ago")).toBeNull();
  });
});

describe("containersFromPs", () => {
  it("o container `-previous` do deploy do Next.js não pertence ao projeto (mas segue gerenciado)", () => {
    const line = (name: string) =>
      JSON.stringify({ ID: name, Names: name, Image: "i", State: "exited", Status: "Exited (0)", Labels: "paas.managed=true,paas.project=loja", Ports: "" });
    const list = containersFromPs([line("paas-loja-app"), line("paas-loja-app-previous")].join("\n"));
    expect(list.find((c) => c.name === "paas-loja-app")).toMatchObject({ projectSlug: "loja" });
    expect(list.find((c) => c.name === "paas-loja-app-previous")).toMatchObject({ managed: true, projectSlug: null });
  });

  it("monta a lista com serviço do compose e saúde; ignora linha inválida", () => {
    const line = (o: Record<string, string>) => JSON.stringify(o);
    const out = [
      line({
        ID: "a1",
        Names: "paas-loja-ledger-1",
        Image: "paas-loja-ledger",
        State: "running",
        Status: "Up 2 minutes (unhealthy)",
        Labels: "com.docker.compose.project=paas-loja,com.docker.compose.service=ledger",
        Ports: "80/tcp, 443/tcp",
      }),
      "não é json",
      line({ ID: "b2", Names: "outro", Image: "nginx", State: "exited", Status: "Exited (0)", Labels: "", Ports: "" }),
    ].join("\n");
    const list = containersFromPs(out);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      name: "paas-loja-ledger-1",
      managed: true,
      projectSlug: "loja",
      service: "ledger",
      health: "unhealthy",
      ports: ["80/tcp", "443/tcp"],
    });
    expect(list[1]).toMatchObject({ name: "outro", managed: false, service: null, health: null, ports: [] });
  });
});

describe("exitCode no docker ps", () => {
  it("lê o código de saída do status de container parado", () => {
    const line = (status: string) => JSON.stringify({ ID: "a1", Names: "paas-loja-app-migrate-1", Image: "x", State: status.startsWith("Exited") ? "exited" : "running", Status: status, Labels: "", Ports: "" });
    expect(containersFromPs(line("Exited (0) 12 minutes ago"))[0]!.exitCode).toBe(0);
    expect(containersFromPs(line("Up 2 minutes"))[0]!.exitCode).toBeNull();
    expect(containersFromPs(line("Exited (1) 3 seconds ago"))[0]!.exitCode).toBe(1);
  });
});

describe("serviço de execução única concluído no docker ps", () => {
  const row = (name: string, service: string, status: string, extra = "") =>
    JSON.stringify({
      ID: name, Names: name, Image: "x", State: status.startsWith("Exited") ? "exited" : "running", Status: status, Ports: "",
      Labels: `com.docker.compose.project=paas-loja,com.docker.compose.service=${service}${extra}`,
    });
  const DEPENDS = ",com.docker.compose.depends_on=app-migrate:service_completed_successfully:true,db:service_healthy:true,com.docker.compose.image=sha256:abc";
  const done = (out: ReturnType<typeof containersFromPs>) => out.filter((c) => c.completed).map((c) => c.name);

  it("saiu com 0 e um container do projeto espera a conclusão (rótulo com vírgulas): concluído", () => {
    const out = containersFromPs([row("migrate", "app-migrate", "Exited (0) 12 minutes ago"), row("web", "app-web", "Up 5 minutes", DEPENDS), row("db", "db", "Exited (0) 1 minute ago")].join("\n"));
    expect(done(out)).toEqual(["migrate"]);
  });

  it("sem dependente criado (profile), com erro ou ainda rodando: não é concluído", () => {
    expect(done(containersFromPs(row("migrate", "app-migrate", "Exited (0) 1 minute ago")))).toEqual([]);
    expect(done(containersFromPs([row("migrate", "app-migrate", "Exited (1) 1 minute ago"), row("web", "app-web", "Up 5 minutes", DEPENDS)].join("\n")))).toEqual([]);
    expect(done(containersFromPs([row("migrate", "app-migrate", "Up 1 minute"), row("web", "app-web", "Up 5 minutes", DEPENDS)].join("\n")))).toEqual([]);
  });

  it("o mesmo nome de serviço em outro projeto não conta", () => {
    const other = JSON.stringify({ ID: "o", Names: "o", Image: "x", State: "exited", Status: "Exited (0) 1 minute ago", Ports: "", Labels: "com.docker.compose.project=paas-outro,com.docker.compose.service=app-migrate" });
    expect(done(containersFromPs([other, row("web", "app-web", "Up 5 minutes", DEPENDS)].join("\n")))).toEqual([]);
  });
});
