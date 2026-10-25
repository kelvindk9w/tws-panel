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
        Names: "paas-loja-wallet-1",
        Image: "paas-loja-wallet",
        State: "running",
        Status: "Up 2 minutes (unhealthy)",
        Labels: "com.docker.compose.project=paas-loja,com.docker.compose.service=wallet",
        Ports: "80/tcp, 443/tcp",
      }),
      "não é json",
      line({ ID: "b2", Names: "outro", Image: "nginx", State: "exited", Status: "Exited (0)", Labels: "", Ports: "" }),
    ].join("\n");
    const list = containersFromPs(out);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      name: "paas-loja-wallet-1",
      managed: true,
      projectSlug: "loja",
      service: "wallet",
      health: "unhealthy",
      ports: ["80/tcp", "443/tcp"],
    });
    expect(list[1]).toMatchObject({ name: "outro", managed: false, service: null, health: null, ports: [] });
  });
});
