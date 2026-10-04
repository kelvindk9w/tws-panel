/**
 * Serviços do compose com a ESTRUTURA do caso real (cassino, 03/10/2026),
 * sem valores reais — o que a detecção devolve para a tela.
 */
import type { ComposeServiceInfo } from "@paas/core";

export const CASSINO_SERVICES: ComposeServiceInfo[] = [
  {
    name: "db",
    image: "postgres:18-alpine",
    build: null,
    publishedPorts: [],
    internalPorts: [],
    networkModeService: null,
    dependsOn: [],
    healthcheck: "compose",
  },
  {
    name: "redis",
    image: "redis:8-alpine",
    build: null,
    publishedPorts: [],
    internalPorts: [],
    networkModeService: null,
    dependsOn: [],
    healthcheck: "compose",
  },
  {
    name: "wallet",
    image: null,
    build: { context: ".", dockerfile: "Dockerfile" },
    publishedPorts: [
      { mapping: "80:80", containerPort: 80, hostPort: 80, panel: "conflict" },
      { mapping: "443:443", containerPort: 443, hostPort: 443, panel: "conflict" },
      { mapping: "127.0.0.1:8010:8010", containerPort: 8010, hostPort: 8010, panel: null },
    ],
    internalPorts: [
      { port: 8009, source: "dockerfile" },
      { port: 8010, source: "dockerfile" },
    ],
    networkModeService: null,
    dependsOn: [
      { service: "db", condition: "service_healthy" },
      { service: "redis", condition: "service_healthy" },
    ],
    healthcheck: "dockerfile",
  },
  {
    name: "web",
    image: null,
    build: { context: ".", dockerfile: "services/web/Dockerfile" },
    publishedPorts: [],
    internalPorts: [{ port: 3200, source: "healthcheck" }],
    networkModeService: "wallet",
    dependsOn: [{ service: "wallet", condition: "service_healthy" }],
    healthcheck: "dockerfile",
  },
  {
    name: "caddy",
    image: "caddy:2-alpine",
    build: null,
    publishedPorts: [],
    internalPorts: [],
    networkModeService: "wallet",
    dependsOn: [
      { service: "web", condition: "service_started" },
      { service: "wallet", condition: null },
    ],
    healthcheck: null,
  },
];
