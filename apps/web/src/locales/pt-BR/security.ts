// Namespace "security" (pt-BR). Chaves planas; plural com sufixos _one/_other.
export default {
  // SecurityPage
  "page.title": "Segurança",
  "page.subtitle": "Proteções da VPS, retrato de referência, monitoramento e reputação do e-mail.",

  // Escalas da nota
  "scale.lynis": "Lynis",
  "scale.internal": "índice interno",

  // HardeningCard
  "score.title": "Nota de segurança",
  "score.refreshing": "atualizando…",
  "score.description": "Nota atual desta VPS e como ela evoluiu.",
  "score.loadError": "Falha ao carregar.",
  "score.loading": "Carregando…",
  "score.source": "/100 · fonte: {source}",
  "score.summary": "{pass} itens OK · {fail} com problema · última verificação {date}",
  "score.evolution": "Evolução: {a} → {b}{arrow}",
  "score.evolutionScales":
    "Primeira verificação: {a} ({scaleA}) · hoje: {b} ({scaleB}) — réguas diferentes",
  "score.badgeTitle": "{date} — {scale}",
  "score.internalNote": "* índice interno do painel (antes de o Lynis existir na VPS)",
  "score.apply": "Verificar e aplicar proteções",

  // BaselineCard
  "baseline.title": "Retrato de referência",
  "baseline.description":
    "Registro dos pacotes, portas e arquivos importantes desta VPS. O monitoramento compara com ele para avisar quando algo muda.",
  "baseline.loadError": "Falha ao carregar o baseline.",
  "baseline.createError": "Falha ao criar o baseline.",
  "baseline.loading": "Carregando…",
  "baseline.created": "Criado em <b>{date}</b> ({target})",
  "baseline.packages_one": "{count} pacotes",
  "baseline.packages_other": "{count} pacotes",
  "baseline.ports_one": "{count} portas",
  "baseline.ports_other": "{count} portas",
  "baseline.files_one": "{count} arquivos rastreados",
  "baseline.files_other": "{count} arquivos rastreados",
  "baseline.empty":
    "Ainda não há retrato de referência. Crie um depois de aplicar as proteções, para o monitoramento ter com o que comparar.",
  "baseline.update": "Atualizar retrato de referência",
  "baseline.create": "Criar retrato de referência",

  // MonitorCard
  "monitor.title": "Monitoramento contínuo",
  "monitor.schedulerOn": "agendador ativo",
  "monitor.schedulerOff": "parado",
  "monitor.description":
    "Verificação automática periódica: compara a VPS com o retrato de referência e avisa quando algo muda.",
  "monitor.loadError": "Falha ao carregar o monitoramento.",
  "monitor.runError": "Falha ao executar o scan.",
  "monitor.saveError": "Falha ao salvar o intervalo.",
  "monitor.intervalInvalid": "Informe um número de horas entre 1 e {max} (uma semana).",
  "monitor.loading": "Carregando…",
  "monitor.interval": "Intervalo (horas):",
  "monitor.intervalAria": "Intervalo (horas)",
  "monitor.save": "Salvar",
  "monitor.runNow": "Verificar agora",
  "monitor.lastRun": "Última verificação: {date}",
  "monitor.lastRunDetail_one": "Última verificação: {date} ({ms}ms, {count} alerta(s))",
  "monitor.lastRunDetail_other": "Última verificação: {date} ({ms}ms, {count} alerta(s))",
  "monitor.noDiff": "Nenhuma diferença em relação ao baseline.",
  "monitor.diff.newPort": "+ porta {proto}/{port}",
  "monitor.diff.closedPort": "- porta {proto}/{port}",
  "monitor.diff.newPackage": "+ pacote {name}",
  "monitor.diff.removedPackage": "- pacote {name}",
  "monitor.diff.changedFile": "~ {file} (alterado)",
  "monitor.diff.removedFile": "- {file} (removido)",
  "monitor.diff.addedFile": "+ {file} (novo)",

  // BlacklistCard
  "blacklist.title": "Reputação do e-mail",
  "blacklist.description":
    "Confere se o IP e os domínios de e-mail estão em listas de bloqueio de spam (Spamhaus, SpamCop, Barracuda).",
  "blacklist.error": "Falha ao consultar as blacklists.",
  "blacklist.status": "{label}: {status}",
  "blacklist.listed": "LISTADO",
  "blacklist.clean": "limpo",
  "blacklist.unknown": "indeterminado",
  "blacklist.removal": "Remoção:",
  "blacklist.checkedAt": "Verificado em {date}",
  "blacklist.check": "Verificar agora",
} as const;
