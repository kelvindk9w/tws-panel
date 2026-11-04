// Namespace "hardening" (pt-BR). Chaves planas; plural com sufixos _one/_other.
export default {
  // IndexGauge
  "gauge.sourceShort.lynis": "Lynis",
  "gauge.sourceShort.internal": "Interno",
  "gauge.sourceLong.lynis": "Lynis Index",
  "gauge.sourceLong.internal": "Índice interno",
  "gauge.aria": "Índice de segurança: {value} de 100 (fonte: {source})",

  // SshKeyGuide
  "sshGuide.toggle": "Nunca usou chave SSH? Veja como gerar em 2 minutos.",
  "sshGuide.whatIs":
    "<b>O que é:</b> um par de chaves criptográficas. A <b>chave privada</b> fica guardada no SEU computador (nunca saia dela nem compartilhe) e a <b>chave pública</b> é instalada no servidor — é ela que você cola aqui.",
  "sshGuide.purpose":
    "<b>Para que serve:</b> é assim que você vai entrar na VPS por SSH <b>depois que o acesso root for desativado</b> pelo hardening. Sem ela instalada, o painel NÃO trava o root (proteção anti-lockout).",
  "sshGuide.windows.title": "🪟 Windows (PowerShell)",
  "sshGuide.windows.step1":
    "Abra o <b>PowerShell</b> e gere o par de chaves (aperte Enter para aceitar o local padrão; a senha da chave é opcional, mas recomendada):",
  "sshGuide.windows.step2": "Exiba a chave pública para copiar (ela fica em <code>{path}</code>):",
  "sshGuide.windows.step3": "Copie a linha inteira exibida (começa com ssh-ed25519) e cole no campo abaixo.",
  "sshGuide.unix.title": "🐧 Linux / 🍎 macOS (Terminal)",
  "sshGuide.unix.step1":
    "Abra o <b>Terminal</b> e gere o par de chaves (aperte Enter para aceitar o local padrão; a senha da chave é opcional, mas recomendada):",
  "sshGuide.unix.step2": "Exiba a chave pública para copiar (ela fica em <code>{path}</code>):",
  "sshGuide.unix.step3":
    "Copie a linha inteira exibida (começa com ssh-ed25519) e cole no campo abaixo. No Mac, dá para copiar direto com <code>{command}</code>.",
  "sshGuide.alreadyHave":
    "💡 <b>Já tem uma chave?</b> Se o comando de exibição acima mostrar uma linha começando com ssh-ed25519 ou ssh-rsa, não precisa gerar outra — use a que você já tem.",

  // ManualPhaseModal
  "manual.aria": "Execução manual — {title}",
  "manual.heading": "Fazer manualmente — {title}",
  "manual.intro":
    "Rode os comandos abaixo no servidor, na ordem (pelo SSH ou pelo terminal embutido do painel). Depois clique em <b>Já executei — verificar de novo</b> para o painel validar a fase.",
  "manual.closeAria": "Fechar janela",
  "manual.satisfied": "✅ Esta fase já aparece como concluída na última verificação.",
  "manual.loading": "Carregando o passo a passo…",
  "manual.stepsLabel": "Passo a passo — comandos exatos (copie e execute um por um):",
  "manual.note": "ℹ️ {note}",
  "manual.script": "Ver o script completo da fase ({script})",
  "manual.close": "Fechar",
  "manual.rescan": "Já executei — verificar de novo",
  "manual.confirmed": "✅ confirmado na última verificação",

  // AccessTestAlert
  "access.changed.01": "A senha do root foi desativada. Confira que você ainda entra com {who}.",
  "access.changed.02": "O SSH agora aceita entrar só por chave e só {who}. Confira que você ainda entra.",
  "access.changed.other": "O firewall foi ligado. Confira que você ainda entra.",
  "access.whoDefault": "o seu usuário",
  "access.title": "Teste seu acesso agora — Fase {phase} ({phaseTitle})",
  "access.step1": "Abra o <b>terminal do seu computador</b> (não o navegador), sem fechar esta página.",
  "access.step2.run": "Rode:",
  "access.step2.fallback": "ssh SEU_USUARIO@{host} (troque pelo usuário que você criou)",
  "access.step2.placeholder": "Troque {placeholder} pelo IP da sua VPS — o mesmo que você usa para entrar por SSH.",
  "access.step3":
    "Apareceu <code>{user}@…$</code>? Deu certo: digite <code>exit</code> e clique em <b>Entrei — confirmar</b>.",
  "access.userFallback": "seu-usuario",
  "access.why": "Por que testar agora: se der errado, desfazemos só esta fase — não todo o trabalho feito até aqui.",
  "access.expired":
    "O prazo acabou sem confirmação: o servidor está desfazendo esta fase. Em instantes a tela mostra o resultado.",
  "access.countdown": "Sem resposta, esta fase se desfaz sozinha em <timer>{time}</timer>.",
  "access.confirm": "✅ Entrei — confirmar",
  "access.undo": "Não consegui entrar — desfazer agora",
  "access.details": "Mais detalhes",
  "access.details.why":
    "<b>Por que um teste em cada fase:</b> as fases 01, 02 e 03 mexem em como você entra na VPS — a senha do root, o SSH e o firewall. Testando uma de cada vez, se algo der errado só aquela fase é desfeita e você sabe exatamente qual foi.",
  "access.details.where":
    "<b>Onde fica o terminal:</b> no Windows, o PowerShell (menu Iniciar → digite \"PowerShell\"); no Mac, o Terminal (Spotlight → \"Terminal\"); no Linux, o Terminal. É o mesmo que você usou para entrar na VPS no começo.",
  "access.details.password":
    "<b>Pediu uma senha?</b> Se for \"Enter passphrase for key\", é a senha da chave SSH que você criou no seu computador — não a senha do servidor.",
  "access.details.keyName":
    "<b>Sua chave tem outro nome?</b> Acrescente <code>-i ~/.ssh/NOME</code> ao comando.",
  "access.details.failed":
    "<b>Não consegui entrar:</b> clique em \"desfazer agora\". Esta fase volta ao que era, as seguintes não rodam, e você pode tentar de novo depois de resolver.",

  // Phase01Card
  "phase01.title": "Fase 01 — desativar a senha do root",
  "phase01.description":
    "Depois desta fase, ninguém entra como root com senha. Você entra com a sua chave SSH e administra com o seu usuário e a senha dele.",
  "phase01.userLabel": "Usuário não-root criado na instalação",
  "phase01.userInvalid": "Nome inválido (minúsculas, sem espaços, nunca root).",
  "phase01.userFromConfig":
    "⚙️ Nome da <b>configuração da instalação</b>. Se não for esse, é só editar.",
  "phase01.userDetected": "🔎 Nome <b>detectado no servidor</b>. Se não for esse, é só editar.",
  "phase01.userNotDetected":
    "A verificação <b>não encontrou</b> <bm>{user}</bm> com sudo neste servidor. Confira o nome e, se preciso, rode como root: <code>usermod -aG sudo {user}</code>",
  "phase01.userMany": "Encontramos <b>{n} usuários</b> com sudo no servidor. Qual deles você criou na instalação?",
  "phase01.userHint": "O nome que você criou ao seguir o README (ex.: deploy).",
  "phase01.whoDefault": "seu usuário",
  "phase01.unchecked":
    "Não deu para conferir {who} nesta verificação. A simulação mostra, antes de qualquer mudança, se a senha do root vai ser desativada.",
  "phase01.hasPassword": "{user} tem senha",
  "phase01.noPassword": "{user} não tem senha",
  "phase01.keys_one": "{count} chave SSH instalada",
  "phase01.keys_other": "{count} chaves SSH instaladas",
  "phase01.keysPasted": " (contando a que você colou)",
  "phase01.noKeys": "nenhuma chave SSH instalada",
  "phase01.resultLocked": "Resultado: a senha do root será desativada.",
  "phase01.resultNoPassword":
    "Resultado: a senha do root não será desativada — sem senha, {user} ficaria sem sudo. Para corrigir, rode <code>sudo passwd {user}</code> no terminal abaixo e clique em “Verificar de novo”.",
  "phase01.resultNoKey":
    "Resultado: a senha do root não será desativada e nada muda — você continua entrando com a senha. Para ativar a proteção, instale sua chave abaixo.",
  "phase01.keyToggleMissing": "Instalar minha chave SSH",
  "phase01.keyToggleOptional": "Adicionar uma chave SSH (opcional)",
  "phase01.keyHelp":
    "Cole o conteúdo do arquivo <code>.pub</code> do seu computador — a fase instala a chave no servidor para você. Se sua chave já está no servidor, deixe em branco.",
  "phase01.keyPublic":
    "<b>A chave pública não é segredo</b> — é feita para ser distribuída. Nunca cole a <b>chave privada</b> (o arquivo sem <code>.pub</code>).",
  "phase01.keyLabel": "Chave pública SSH (conteúdo do arquivo .pub) — opcional",
  "phase01.keyPlaceholder": "ssh-ed25519 AAAAC3NzaC… voce@sua-maquina",
  "phase01.keyInvalid":
    "Formato não reconhecido — cole o conteúdo completo do arquivo .pub (uma linha, começando com ssh-ed25519 ou ssh-rsa).",
  "phase01.keyValid": "Sua chave parece válida ✅",
  "phase01.detailsToggle": "Detalhes e emergência",
  "phase01.details.apply":
    "Ao aplicar, abra uma <b>nova janela SSH</b> (sem fechar a atual) e teste o login antes de confirmar. Se você não confirmar em 5 minutos, a mudança é desfeita sozinha.",
  "phase01.details.lostKey":
    "Perdeu a chave? Entre pelo <b>console da sua hospedagem</b> (VNC, no painel do provedor) com <bm>{who}</bm> e a senha dele — a senha do root não funciona mais lá.",
  "phase01.details.dontConfuse":
    "<b>Não confunda:</b> a chave SSH é como você <b>entra</b> na VPS pelo SSH; a senha do sudo é o que <b>autoriza</b> comandos administrativos. Para desativar a senha do root sem te trancar para fora, a fase exige pelo menos uma chave instalada e a senha de {who}.",
  "phase01.details.insecure":
    "Esta página está sem criptografia (http fora do túnel SSH). Colar a chave pública não vaza nada útil, mas alguém no caminho poderia <b>alterar</b> o que trafega — prefira o túnel SSH.",

  // Títulos das fases (SECURITY_PHASES, de @paas/core)
  "phaseTitle.00": "Atualizações do sistema",
  "phaseTitle.01": "Usuário não-root",
  "phaseTitle.02": "Hardening de SSH",
  "phaseTitle.03": "Firewall (UFW)",
  "phaseTitle.04": "Prevenção de intrusão",
  "phaseTitle.05": "Minimização de pacotes",
  "phaseTitle.06": "Auditoria e detecção",
  "phaseTitle.07": "Endurecimento adicional",
  "phaseLabel": "Fase {id} — {title}",

  // SecurityStep: estados, selos e ícones
  "phaseRun.pending": "aguardando",
  "phaseRun.running": "executando",
  "phaseRun.done": "concluída",
  "phaseRun.error": "erro",
  "phaseRun.skipped": "pulada",
  "severity.critical": "crítico",
  "severity.warning": "atenção",
  "severity.info": "info",
  "jobStatus.running": "executando…",
  "jobStatus.awaiting": "aguardando confirmação",
  "jobStatus.success": "concluído",
  "jobStatus.failed": "falhou",
  "jobStatus.rolledBack": "revertido",
  "scale.lynis": "Lynis",
  "scale.internal": "índice interno do painel",

  // SecurityStep: cabeçalho e erros
  "header.backPage": "Voltar para Segurança",
  "header.backWizard": "Voltar para Saúde da máquina",
  "header.title": "Segurança",
  "header.subtitle":
    "Verificação da VPS, plano de correção e proteções em fases — com simulação, backup e reversão automática.",
  "error.scan": "Falha ao executar a verificação.",
  "error.plan": "Falha ao gerar o plano.",
  "error.manualLoad": "Falha ao carregar os comandos manuais.",
  "error.rescan": "Falha ao verificar de novo.",
  "error.apply": "Falha ao aplicar a fase.",
  "error.undo": "Falha ao desfazer a fase.",
  "error.confirm": "Falha ao confirmar o acesso.",
  "error.confirmRetry": "{message} Tente confirmar de novo.",
  "error.confirmNetwork":
    "Não foi possível confirmar o acesso agora (falha de conexão). Tente de novo — a fase continua aguardando.",
  "error.nothingPending": "Nenhuma fase com pendência — o servidor já está endurecido.",
  "error.undone":
    "Você desfez a fase \"{title}\": a configuração anterior foi restaurada. Quando resolver o acesso, rode o hardening de novo.",
  "error.expired":
    "O prazo da fase \"{title}\" acabou sem confirmação, e ela foi desfeita automaticamente: a configuração anterior voltou. Rode de novo quando puder testar o acesso.",
  "error.failed": "A fase \"{title}\" falhou. O rollback foi executado — veja o log.",
  "elevation.scan": "A verificação não foi executada: o sudo não autorizou",
  "elevation.phase": "A fase \"{title}\" parou: o sudo não executou o script",
  "elevation.hint": "A senha é pedida no terminal ao vivo, abaixo, quando o comando começa.",
  "elevation.retry": "Tentar a verificação de novo",

  // SecurityStep: verificação (scan)
  "scan.title": "Verificação de segurança",
  "scan.description":
    "Confere SSH, firewall, portas, pacotes e Docker e roda o Lynis, a ferramenta de auditoria de segurança. Se o Lynis ainda não estiver na VPS, ele é instalado do repositório oficial do Ubuntu — é a única coisa que a verificação altera. Leva de 2 a 5 minutos.",
  "scan.start": "Iniciar verificação",
  "scan.running": "Verificando a VPS… (o Lynis leva de 2 a 5 minutos)",
  "scan.ok": "✅ ok",
  "scan.warning": "⚠️ atenção",
  "scan.critical": "❌ crítico",
  "scan.target": "alvo: {target}",
  "scan.profile": "perfil: {profile}",
  "scan.total": "{total} verificações em {seconds}s",
  "scan.noLynis": "(Lynis ausente — índice interno)",
  "scan.skipped_one": "{count} check(s) pulados neste perfil",
  "scan.skipped_other": "{count} check(s) pulados neste perfil",
  "scan.phaseAllOk": "tudo ok",
  "scan.phasePending_one": "{count} pendente(s)",
  "scan.phasePending_other": "{count} pendente(s)",
  "scan.again": "Verificar de novo",
  "scan.buildPlan": "Gerar plano de correção",

  // SecurityStep: plano
  "plan.title": "Plano de correção",
  "plan.description_one":
    "{count} fase(s) com pendências. Execute <b>uma fase por vez</b> (botão em cada fase) ou todas em sequência (botão abaixo) — tudo roda primeiro em dry-run; se uma falhar, a execução para e o rollback é aplicado. Prefere rodar por conta própria? Use <b>Fazer manualmente</b> para ver o passo a passo copiável.",
  "plan.description_other":
    "{count} fase(s) com pendências. Execute <b>uma fase por vez</b> (botão em cada fase) ou todas em sequência (botão abaixo) — tudo roda primeiro em dry-run; se uma falhar, a execução para e o rollback é aplicado. Prefere rodar por conta própria? Use <b>Fazer manualmente</b> para ver o passo a passo copiável.",
  "plan.satisfied": "já ok",
  "plan.fixes_one": "{count} correção(ões)",
  "plan.fixes_other": "{count} correção(ões)",
  "plan.rollback": "com rollback",
  "plan.alreadyApplied":
    "Esta fase já foi aplicada com sucesso em {date}, mas o item abaixo continua reprovado — aplicar de novo provavelmente não resolve. Algo no servidor está desfazendo ou sobrepondo a correção:",
  "plan.phase01Hint":
    "Informe abaixo o usuário não-root criado na instalação para habilitar esta fase (a chave SSH é opcional).",
  "plan.dryRunHint":
    "Começa por uma <b>simulação</b> (dry-run) só desta fase, no terminal abaixo: nada é alterado no servidor. No modo senha, o sudo vai pedir a sua senha. Se a simulação passar, aparece o botão para aplicar de verdade.",
  "plan.manual": "Fazer manualmente",
  "plan.runOne": "Executar apenas esta fase",
  "plan.backToReport": "Voltar ao relatório",
  "plan.simulateAll": "Simular todas as fases pendentes (dry-run)",
  "plan.dryRunSummary": "<b>Nada é alterado no servidor</b> — é só uma simulação.",
  "plan.dryRunHelp": "O que isso faz?",
  "plan.dryRunExplain":
    "Roda a <b>simulação</b> de todas as fases pendentes, na ordem. <b>Nada é alterado no servidor</b> — você acompanha tudo no terminal abaixo. No modo senha, o sudo vai pedir a sua senha no terminal. Se a simulação passar, aparece então o botão para aplicar de verdade.",
  "plan.invalidForm":
    "Informe o usuário criado na instalação para executar a Fase 01 — a chave pública SSH é opcional, mas se você colar uma ela precisa estar em formato válido (ou use \"Fazer manualmente\" na fase).",

  // SecurityStep: execução
  "run.titleDry": "Dry-run (simulação)",
  "run.titleReal": "Aplicando hardening",
  "run.stoppedAt": "Parou na Fase {id} — {title}",
  "run.progress": "Fase {current} de {total}",
  "run.progressJob": "Fase {current} de {total} — {title}",
  "run.pending": "aguardando",
  "run.skipped": "pulada (modo manual)",
  "run.liveLog": "Log em tempo real — {title}",
  "run.noOutput": "(sem saída ainda)",
  "run.failedDry": "A simulação parou na Fase {id} — {title}",
  "run.failedReal": "A aplicação parou na Fase {id} — {title}",
  "run.failedDryNote": "Nada foi alterado no servidor — era uma simulação. As fases seguintes não rodaram.",
  "run.failedRealNote": "As fases seguintes não rodaram. O log da fase (acima, se houver) mostra o que aconteceu.",
  "run.retryDry": "Tentar a simulação de novo",
  "run.backToPlan": "Voltar ao plano",
  "run.dryDone": "Simulação concluída sem erros — nada foi alterado no servidor.",
  "run.dryDoneBody_one":
    "A simulação percorreu a fase acima sem tocar em nada. Ao clicar em <b>Aplicar de verdade</b>, os mesmos passos rodam <b>alterando o servidor</b>: cada arquivo modificado ganha backup antes, e as fases de SSH/firewall entram com rollback automático de 5 minutos, revertendo sozinhas se você não confirmar que ainda consegue acessar o servidor.",
  "run.dryDoneBody_other":
    "A simulação percorreu as {count} fases acima, na ordem, sem tocar em nada. Ao clicar em <b>Aplicar de verdade</b>, os mesmos passos rodam <b>alterando o servidor</b>: cada arquivo modificado ganha backup antes, e as fases de SSH/firewall entram com rollback automático de 5 minutos, revertendo sozinhas se você não confirmar que ainda consegue acessar o servidor.",
  "run.realWarning": "Agora a VPS será alterada de verdade.",
  "run.applyReal": "Aplicar de verdade",

  // SecurityStep: resultado
  "done.title": "Proteções aplicadas",
  "done.subtitle": "Como a VPS chegou e como ela está hoje.",
  "done.first": "Quando a VPS chegou",
  "done.today": "Hoje",
  "done.waiting": "Auditoria completa com o Lynis em andamento — leva de 2 a 5 minutos.",
  "done.scales":
    "As duas notas usam réguas diferentes ({first} e {today}) — por isso não mostramos a diferença em pontos. Nas instalações novas, a primeira verificação já usa o Lynis.",
  "done.lastApply_one": "Última aplicação: {before} → {after} ({scale}), {delta} pontos",
  "done.lastApply_other": "Última aplicação: {before} → {after} ({scale}), {delta} pontos",
  "done.lastApplyScales": "Última aplicação: {before} → {after} ({scaleBefore} → {scaleAfter})",
  "done.drift":
    "A nota era {after} logo depois da última aplicação e hoje é {today}. A nota muda com o tempo: atualizações de segurança novas ainda não instaladas e um reinício pendente tiram pontos até serem aplicados. Veja o relatório completo para saber o que mudou.",
  "done.deltaUp_one": "+{delta} pontos no índice",
  "done.deltaUp_other": "+{delta} pontos no índice",
  "done.deltaSame": "índice mantido — correções aplicadas",
  "done.deltaDown_one": "{delta} pontos — revise o relatório",
  "done.deltaDown_other": "{delta} pontos — revise o relatório",
  "done.remaining": "⚠️ Ainda ficou reprovado (crítico):",
  "done.verifyAgain": "Verificar de novo",
  "done.fullReport": "Ver relatório completo",
  "done.backToSecurity": "Voltar para Segurança",
  "done.continue": "Continuar",
} as const;
