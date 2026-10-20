// Namespace "compose" (pt-BR). Chaves planas; plural com sufixos _one/_other.
export default {
  // ComposeServices: origem das portas internas
  "source.expose": "expose",
  "source.dockerfile": "EXPOSE do Dockerfile",
  "source.healthcheck": "do healthcheck",
  "source.environment": "variável PORT",
  // ComposeServices: condição de dependência
  "condition.healthy": "saudável",
  "condition.started": "iniciado",
  "condition.completed": "concluído",
  // ComposeServices: healthcheck
  "healthcheck.compose": "Healthcheck no compose",
  "healthcheck.dockerfile": "Healthcheck no Dockerfile",
  "healthcheck.disabled": "Healthcheck desligado",
  "healthcheck.none": "Sem healthcheck",
  // ComposeServices: estado do container
  "state.none": "sem container",
  "state.unhealthy": "não saudável",
  "state.healthy": "saudável",
  "state.starting": "iniciando",
  "state.running": "rodando",
  "state.restarting": "reiniciando",
  "state.created": "não iniciou",
  "state.stopped": "parado",
  // ComposeServices: entrada HTTP
  "entry.explanation":
    "O {main} atende dentro do {entry} (network_mode: service:{entry}), por isso a entrada é {where} — a porta em que o {main} escuta.",
  "entry.sharedNetwork_one": "{names} também usa a rede do {entry}.",
  "entry.sharedNetwork_other": "{names} também usam a rede do {entry}.",
  "entry.arrives": "O HTTP do painel chega em <code>{target}</code>",
  "entry.none": "Nenhum serviço escolhido para receber o HTTP do painel.",
  // ComposeServices: lista de serviços
  "service.httpEntry": "entrada HTTP",
  "service.image": "Imagem <code>{image}</code>",
  "service.build": "Construído do repositório (<code>{path}</code>)",
  "service.noImage": "Sem imagem nem build",
  "service.publishedPorts": "Portas publicadas:",
  "service.panelRemoves": "(o painel retira)",
  "service.panelConflict": "(conflita com o painel)",
  "service.internalPorts": "Portas internas:",
  "service.usesNetwork": "Usa a rede do {service}",
  "service.dependsOn": "Depende de:",
  "conflictNote":
    "As portas 80 e 443 marcadas como “conflita com o painel” são de um proxy HTTPS próprio: o painel não as retira e o deploy fica bloqueado. O caminho é um compose.paas.yaml sem essas portas.",
  // ComposeEntryPicker
  "picker.service": "Serviço que recebe o HTTP",
  "picker.choose": "escolha um serviço",
  "picker.networkHint": "Quem usa a rede de outro serviço (network_mode) não aparece: a entrada é o dono da rede.",
  "picker.port": "Porta interna (dentro da rede Docker)",
  "picker.portInvalid": "Use um número entre 1 e 65535.",
  "picker.knownPorts": "Portas conhecidas:",
  // ComposeServicesCard
  "card.title": "Serviços do compose",
  "card.description": "O que sobe no deploy e por onde o site recebe as visitas.",
  "card.legacy":
    "Este projeto foi lido antes de o painel listar os serviços. Leia o compose de novo para ver todos (nada é publicado agora).",
  "card.redetect": "Ler o compose de novo",
  "card.redetectFailed": "Falha ao ler o compose.",
  "card.save": "Salvar entrada",
  "card.saveFailed": "Falha ao salvar a entrada.",
  "card.saved": "Entrada salva — vale no próximo deploy.",
} as const;
