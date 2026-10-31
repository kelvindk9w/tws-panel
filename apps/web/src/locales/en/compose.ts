// Namespace "compose" (en). Same keys and order as pt-BR.
export default {
  // ComposeServices: origem das portas internas
  "source.expose": "expose",
  "source.dockerfile": "Dockerfile EXPOSE",
  "source.healthcheck": "from the healthcheck",
  "source.environment": "PORT variable",
  // ComposeServices: condição de dependência
  "condition.healthy": "healthy",
  "condition.started": "started",
  "condition.completed": "completed",
  // ComposeServices: healthcheck
  "healthcheck.compose": "Healthcheck in compose",
  "healthcheck.dockerfile": "Healthcheck in Dockerfile",
  "healthcheck.disabled": "Healthcheck disabled",
  "healthcheck.none": "No healthcheck",
  // ComposeServices: estado do container
  "state.none": "no container",
  "state.unhealthy": "unhealthy",
  "state.healthy": "healthy",
  "state.starting": "starting",
  "state.running": "running",
  "state.restarting": "restarting",
  "state.created": "not started",
  "state.stopped": "stopped",
  "state.completed": "completed (exited with 0)",
  "state.exitedWith": "stopped (exited with {code})",
  // ComposeServices: entrada HTTP
  "entry.explanation":
    "{main} runs inside {entry} (network_mode: service:{entry}), so the entry is {where} — the port {main} listens on.",
  "entry.sharedNetwork_one": "{names} also uses the {entry} network.",
  "entry.sharedNetwork_other": "{names} also use the {entry} network.",
  "entry.arrives": "Panel HTTP traffic arrives at <code>{target}</code>",
  "entry.none": "No service chosen to receive the panel's HTTP traffic.",
  // ComposeServices: lista de serviços
  "service.httpEntry": "HTTP entry",
  "service.image": "Image <code>{image}</code>",
  "service.build": "Built from the repository (<code>{path}</code>)",
  "service.noImage": "No image or build",
  "service.publishedPorts": "Published ports:",
  "service.panelRemoves": "(the panel removes it)",
  "service.panelConflict": "(conflicts with the panel)",
  "service.internalPorts": "Internal ports:",
  "service.usesNetwork": "Uses the {service} network",
  "service.dependsOn": "Depends on:",
  "conflictNote":
    "Ports 80 and 443 marked “conflicts with the panel” belong to a proxy with its own HTTPS: the panel does not remove them and the deploy stays blocked. The fix is a compose.paas.yaml without those ports.",
  // ComposeEntryPicker
  "picker.service": "Service that receives HTTP",
  "picker.choose": "choose a service",
  "picker.networkHint": "Services that use another service's network (network_mode) are not listed: the entry is the network owner.",
  "picker.port": "Internal port (inside the Docker network)",
  "picker.portInvalid": "Use a number between 1 and 65535.",
  "picker.knownPorts": "Known ports:",
  // ComposeServicesCard
  "card.title": "Compose services",
  "card.description": "What starts on deploy and where the site receives visits.",
  "card.legacy":
    "This project was read before the panel listed services. Read the compose file again to see them all (nothing is published now).",
  "card.redetect": "Read compose again",
  "card.redetectFailed": "Failed to read the compose file.",
  "card.save": "Save entry",
  "card.saveFailed": "Failed to save the entry.",
  "card.saved": "Entry saved — it applies on the next deploy.",
} as const;
