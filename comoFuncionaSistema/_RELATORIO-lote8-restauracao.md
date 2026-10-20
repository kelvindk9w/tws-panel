# Relatório do lote 8 — restauração de backup entre servidores

Branch `worktree-agent-a5d7cd5f1ec3e4cb9`, a partir de `origin/dev` (commit base `4ed826e`, que contém `apps/web/src/locales`). Sem push. Itens 1 a 7 da tarefa "Restaurar de outro servidor".

Commits: `928fa9a` (item 1), `215a7c0` (itens 2 a 5, serviço), `b19ec53` (tela da pausa), `7ed8335` (item 6), `fdc0ca6` (item 7), mais o commit deste relatório. Os itens 2 a 5 ficaram num commit só porque mexem nas mesmas funções de `backup-service.ts` (`stagePanel`/`tick`).

## Como funciona agora, em uma frase por item

1. Projeto de upload ou de pasta do servidor numa VPS nova: o código volta para a pasta de origem do cadastro **antes** da publicação.
2. Depois de restaurar o painel, a agenda de **projetos e e-mail** fica em pausa até os dados de cada um voltarem.
3. Painel recém-instalado, sem nada seu, não envia backup **agendado** por cima dos backups de outro servidor.
4. Restaurar o painel mantém o armazenamento (endpoint, bucket, chaves) que está em uso nesta VPS.
5. O acesso pelo IP desativado no painel antigo só continua desativado se o domínio do painel já aponta para esta VPS.
6. O `docker-compose.yml` repassa `ALLOWED_ORIGINS`.
7. O kit e as telas dizem, sem ambiguidade, que as chaves de acesso do armazenamento não estão no kit.

## Item 1 — projetos que não vêm do GitHub

**Confirmado no código.** `restoreProject` publicava (`redeploy`) e só depois, no laço de itens, extraía o `codigo.tar`. Em `upload`, `ingestUpload` apaga `.paas/<id>/src` e copia de `project.source`, que não existe na VPS nova. Em `existing`, a própria `project.source` não existe. Além disso o tar era extraído por cima da pasta do usuário quando ela já existia (sobrescrevendo arquivos).

**Testes que falharam antes** (`apps/server/tests/backup-service.test.ts`, bloco "VPS nova: projeto que não vem do GitHub (lote 8, item 1)"): upload e existing não tinham a fonte no lugar na hora da publicação; "pasta que já existe não é tocada" falhou porque o arquivo do usuário foi sobrescrito pelo do backup; origem fora da pasta de projetos terminava em aviso e não em falha.

**O que mudou (comportamento).** Quando o projeto não tem containers e a restauração pede para publicar, e o projeto não é de GitHub, o painel primeiro devolve o código à pasta de origem do cadastro e só então publica:
- o destino vem do cadastro do projeto, nunca do manifesto do backup;
- só grava dentro da pasta de projetos e nunca na área do painel (`.paas` ou a própria pasta de projetos); fora disso a restauração falha com mensagem clara, sem gravar nada e sem publicar;
- se a pasta de origem já existe com arquivos, ela fica como está (aviso no registro) e a publicação usa o que está lá; pasta vazia é preenchida;
- o tar é aberto numa pasta privada de trabalho e só então copiado (links não são seguidos); se a cópia falha, o que foi criado é desfeito;
- o comportamento com containers já existentes (voltar o código por cima, como "voltar a versão") e o de projetos do GitHub não mudou.

**Prova real** (script fora do repositório, `.../scratchpad/prova-item1.mts`): `BackupService` real, `DockerCli` real com um container e um volume Docker reais, `tar` real e `ingestCode` real do `@paas/deploy`; pasta e dados apagados para simular a VPS nova. Nos dois modos: **antes da correção** a restauração falhou (`ENOENT` na pasta de origem, sem container); **depois**, a fonte estava no lugar na hora da publicação, a ingestão copiou o código, o container subiu e o arquivo do volume voltou (`dados-do-usuario`). Tudo foi removido ao final (containers, volume, pastas temporárias).

## Item 2 — agenda durante e depois de restaurar o painel

**Confirmado.** `backups.json` volta com `lastSlot` antigo e a varredura de 60 s pode disparar na hora. Detalhe que o revisor não notou: com **zero** containers o backup agendado falha com "Nenhum container" (`BackupFailure`, não desliga nada, mas gera notificação de falha por projeto); o desligamento do automático (`NothingToBackup`) acontece quando há containers e nada marcado, por exemplo um projeto recém-publicado cujos volumes ainda estão vazios. Os dois efeitos são evitados pela pausa.

**Definição precisa.** Ao restaurar o painel, a cópia de `backups.json` que vai entrar no lugar recebe `restoreHold = { since, released: [] }`. Enquanto a pausa vale, `tick()` não agenda o item e não desliga nada. A pausa vale para o **e-mail** e para **cada projeto cadastrado antes da restauração** (projeto criado depois não é afetado). O **painel** não é pausado (o horário atual conta como atendido). A pausa de um item acaba quando:
- a restauração dos dados dele termina sem falhar (projeto ou e-mail), ou
- um backup feito à mão dele termina sem falhar, ou
- passam 7 dias (nada fica sem backup para sempre; depois disso o comportamento é o de antes).

Ao liberar, o horário que passou conta como atendido (não dispara um backup na hora). A tela (Configurações → Backups e aba Backups do projeto) mostra o motivo (`pausedReason`) e não promete "Próximo: …".

**Testes que falharam antes:** o backup agendado rodou e desligou o automático do projeto; depois, as regras de liberação (restauração, backup à mão, 7 dias, projeto novo, painel fora da pausa) foram escritas junto. Telas: dois testes (`backup-settings` e `project-backups`) falharam antes da exibição do motivo.

## Item 3 — painel novo que enviaria um backup vazio

**Decisão:** a regra mais simples e segura é não enviar o backup **agendado** do painel quando as três coisas são verdadeiras: nenhum projeto cadastrado, nenhum backup do painel concluído por esta instalação (`lastSuccessAt` nulo) e o armazenamento já guarda backups em `_painel/`. Nesse caso o horário é marcado como atendido (a conferência é uma por horário), o motivo aparece na tela e no log, e o painel tenta de novo no próximo horário. Qualquer coisa a mais (um projeto, um backup à mão, a restauração do painel, que traz `lastSuccessAt`) libera.

Por que esta regra e não "a retenção nunca apaga backups de outro servidor": o painel não sabe de qual servidor veio cada arquivo (os nomes são só data e hora), então distinguir exigiria baixar e abrir cada arquivo ou mudar o formato. A regra escolhida não depende disso, não tem falso negativo na migração e quase não tem custo num painel realmente novo (num armazenamento vazio o primeiro backup sai normalmente). Se a listagem falha, o painel não envia (fail-closed) e diz por quê.

**Testes que falharam antes:** o agendado enviava o backup do painel vazio por cima. Casos cobertos: sem projetos e com backup de outro servidor (não envia, também nos dias seguintes), armazenamento sem backup do painel (envia), com projetos (envia), backup à mão (sempre faz).

## Item 4 — chaves do armazenamento depois de restaurar o painel

**Decisão: manter o que está em uso, e avisar.** Na preparação da restauração (`stagePanel`), a cópia de `backups.json` que vai entrar no lugar recebe o `destination` atual (endpoint, bucket, chaves) lacrado com a chave `backups-key` **do backup** (é ela que vai estar em disco depois da troca). A senha dos backups continua sendo a do backup (abre as cópias antigas). Se as chaves do backup diferiam, o registro da restauração avisa que as de agora foram mantidas e recomenda revogar o token antigo no provedor se o servidor antigo foi invadido. Backup antigo sem `backups.json`/`backups-key`: levam-se os de agora (senão o painel ficaria sem armazenamento). Justificativa: as chaves em uso são exatamente as que acabaram de baixar o backup, ou seja, sabidamente funcionam; as do backup podem estar revogadas.

**Teste que falhou antes:** com token novo configurado após o backup, o `backups.json` preparado trazia o `accessKeyId` antigo.

## Item 5 — acesso pelo IP desativado

**Decisão: não herdar enquanto o domínio não aponta para esta VPS, e avisar.** Na preparação da restauração, se o `panel-domain.json` do backup tem `ipAccessDisabled=true`, o painel consulta o DNS do domínio (novo método `PanelDomainService.pointsHere`, o mesmo teste do botão "Verificar DNS", só leitura). Se aponta para esta VPS, continua desativado (segurança intacta). Se não aponta, não responde ou não há como conferir, a cópia preparada volta com o acesso pelo IP **ativo** e o registro da restauração diz por quê e como desativar de novo depois (Configurações → Domínio do painel). Nada em `panel-domain.json` além desse campo muda.

**Testes que falharam antes:** o campo vinha `true`. Casos: não aponta (reativa e avisa), aponta (mantém), sem como conferir (reativa), já ativo (nada muda, sem aviso), e `pointsHere` com resolvedor com falha ou sem IP do servidor.

## Item 6 — `ALLOWED_ORIGINS` no compose

`docker-compose.yml` passou a repassar `ALLOWED_ORIGINS: ${ALLOWED_ORIGINS:-}` (vazio por padrão: o `loadConfig` já trata vazio como nenhuma origem extra, então o comportamento atual não muda). Comentário explicando no compose; `docs/internal/allowed-origins.md` novo (linkado em `docs/README.md`) e atualização de `comoFuncionaSistema/global/configuracao.json`. Não existe `.env.example` no repositório (o `.env` é gerado pelo `install.sh`); não criei um. Verifiquei com `docker compose config` (vazio e com valor). Teste: `apps/server/tests/config.test.ts` (compose repassa; vazio e ausente dão lista vazia; lista com espaços). Falhou antes porque o compose não tinha a variável. `docker-compose.dev.yml` já tinha.

## Item 7 — chaves no kit (texto, sem mudar o conteúdo do kit)

O kit **não** passou a incluir segredos. O texto do kit (`buildRecoveryKit`, em português) ganhou a seção "O QUE ESTE KIT NÃO TEM" (Access Key ID e Secret Access Key não estão no arquivo, de propósito; guarde à parte; sem elas não baixa nada numa VPS nova; se perdeu, crie token novo no mesmo bucket) e o passo 3 de "Restaurar numa VPS nova" deixou de sugerir que as chaves estão no kit. Na interface (en e pt-BR, módulo de i18n): `password.kitHelp` ao lado do botão de baixar o kit e o novo `other.keysNote` no passo 1 do cartão "Restaurar de outro servidor". Teste de paridade passa. Registrei as mensagens novas do servidor em `comoFuncionaSistema/_i18n-servidor-fase2.tsv` (as linhas citam `backup-service.ts` com números aproximados).

## Correções depois da reprovação do revisor

Commit `fix(backup): correções da revisão do lote 8`. Cada ponto teve teste que falhou antes (exceto o texto do passo 5 do kit, cujo teste foi escrito junto com a mudança).
- **A.1** Link simbólico acima do destino: o caminho é resolvido (`realpath` do ancestral que existe, e de novo da pasta-mãe depois do `mkdir`) e conferido contra a pasta de projetos e `.paas`. Teste com link real (`projects/ponte` apontando para fora): antes terminava em aviso; agora falha e nada é gravado fora.
- **A.2** `GENERATED_HEADER` exportado de `@paas/deploy`. No modo upload o `.env` com o cabeçalho do painel é apagado da pasta de origem depois da cópia; o do dono fica. Teste com `writeProjectDotenv` e `ingestCode` reais e dois deploys seguidos (antes o `.env` voltava).
- **A.3** Descoberto no teste: copiar para uma pasta que já existe vazia **sempre falhava** (`ERR_FS_CP_EEXIST`), então o caso "pasta vazia é preenchida" nunca funcionou. A cópia agora é entrada por entrada; se falha, o conteúdo copiado é removido (a pasta toda, se foi criada agora). Testes: pasta vazia preenchida; falha no meio (arquivo ilegível) deixa a pasta vazia.
- **B** Ao restaurar o painel, projetos com containers e o e-mail (se o container existe) entram como liberados; VPS nova segue como antes. O texto da pausa não diz mais "de outro servidor". Testes: mesma VPS sem pausa; VPS nova com pausa.
- **C** `tick()`: pausa e regra do painel novo só pulam o agendamento; o aviso "sem backup externo há N dias" continua. Testes para projeto em pausa e para o painel parado pela regra.
- **D** Regra do painel novo: e-mail com backup concluído conta como conteúdo próprio; solta 7 dias depois da conexão do armazenamento; notifica uma vez (`backup-panel-held`) ao entrar em pausa; listagem que falha 3 vezes seguidas notifica (`backup-panel-held-error`) e continua sem enviar. Testes: só com e-mail, reinstalado no mesmo bucket (8 dias), listagem sempre falhando, aviso único.
- **E** Esta lista do guia (itens 4, 5, 6, 8, 9, mais 11 a 13) e o `_i18n-servidor-fase2.tsv`.

## Verificação

- `pnpm install --frozen-lockfile`, `pnpm -r run typecheck`: sem erros.
- Cobertura de todos os pacotes (`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`, server com `--maxWorkers=2`): todos passam, sem violação de mínimo. Server 97,71 / 93,29 / 98,05 / 98,9 (mín. 94/91/98/94); deploy 95,72% de ramos (mín. 95); mailer 98,45% de ramos (mín. 98); core, security e web passam. Testes: server 1956 (2 ignorados), web 957, deploy 833, outros 119/362/215.
- Testes novos: server (`backup-service.test.ts`: 6 do item 1 e 17 dos itens 2 a 5; `panel-domain.test.ts`: 1; `config.test.ts`: 1), core (1), web (2 da pausa e 2 asserções do item 7).

Desvio de processo (TDD): o teste de `PanelDomainService.pointsHere` foi escrito na mesma etapa do método, sem uma rodada vermelha separada; os demais testes novos foram vistos falhando antes pelo motivo certo.

## O que NÃO foi testado de verdade

- **Restauração do painel de ponta a ponta com reinício**: os itens 2 a 5 foram testados no preparo (`stagePanel`) com o 7-Zip substituído por um arquivador de mentira e, para o item 2, simulando a subida copiando `backups.json`/`backups-key` preparados para o lugar. A troca real (`applyPendingPanelRestore`) não mudou e não foi reexecutada com os arquivos ajustados.
- **7-Zip real e armazenamento S3/R2 real**: não há `7zz` nesta máquina; a prova do item 1 usou um `.tar` no lugar do `.7z`, só cópia local, sem armazenamento externo.
- **DNS real** no item 5: `pointsHere` foi testado com resolvedores de mentira; não fiz consulta de DNS real nem rodei o fluxo numa VPS.
- **Permissões**: o `cp` do código roda como o usuário do painel (10001 em produção); não testei pasta de projetos sem escrita (o erro tratado existe, mas é só coberto por leitura do código).
- Layout antigo (`storageLayout` legado) de projeto upload/existing na VPS nova: coberto só pela leitura do código; os testes usam `reserved`.
- Interface: testes de componentes (jsdom); sem navegador real.

## Riscos residuais

- `scripts/restaurar-painel.sh` (restauração por arquivo, por SSH) **não** passa por esses ajustes: continua herdando as chaves, o `ipAccessDisabled` e o `lastSlot` do backup.
- A pausa depende do `createdAt` do projeto para não atingir projetos novos; relógio muito diferente entre servidores pode errar por horas (efeito pequeno).
- Um projeto abandonado fica 7 dias sem backup automático depois de uma migração (de propósito); depois voltam as falhas "Nenhum container" de antes.
- O e-mail restaurado e iniciado vazio antes da restauração dos dados poderia sobrescrever `_email/`; o guia manda restaurar o e-mail antes de iniciar. Não apliquei ao e-mail a regra do item 3 (ficou só a pausa do item 2).
- O rótulo da caixa "Publicar do GitHub antes de restaurar" continua dizendo GitHub, mas serve também a upload/existing; mudar o rótulo mexeria nos nomes citados pelos guias (outra frente), então deixei para o Kelvin decidir.
- Item 3: um painel realmente novo, sem projetos, com um armazenamento que já tem backups do painel (reinstalação na mesma VPS sem restaurar) não envia backup agendado até ter um projeto, restaurar ou fazer backup à mão; a tela explica.

## O que muda no guia do site (`restore-new-server.md`, en e pt-br) depois do merge

Não editei `site/src/content/docs`. Quando este código estiver mesclado:

1. **Tabela "O que você precisa" (linha das chaves de acesso)**: continua verdadeira (as chaves não estão no kit). Trocar "Veja o aviso do passo 5" por: as chaves digitadas na VPS nova continuam valendo depois de restaurar o painel.
2. **Tabela "O que volta / não volta"**: remover a linha "Projetos que não vêm do GitHub … este fluxo não os restaura" e o link para `#projetos-fora-do-github`; incluir esses projetos na linha dos projetos ("o código volta do backup para a pasta de origem; os de GitHub são publicados do repositório").
3. **Passo 3, caixa de aviso ("Do not click Fazer backup agora…")**: pode ser encurtada. O backup agendado do painel vazio não é mais enviado se o armazenamento já tem backups do painel de outro servidor; manter só "não clique em Fazer backup agora no painel novo antes do passo 5" (o backup à mão continua sempre sendo feito).
4. **Passo 5, aviso "As chaves do armazenamento voltam às antigas"**: o contorno (digitar as chaves de novo em Editar) **some só para a restauração pelo painel**, que agora mantém as chaves em uso. **Manter o aviso** para o caminho `restaurar-painel.sh` (restauração por arquivo, por SSH), que continua herdando as chaves antigas; manter também a recomendação de revogar o token antigo e trocar senhas se o servidor antigo foi invadido.
5. **Passo 5, aviso "Se o painel antigo tinha o acesso pelo IP desativado"**: para a restauração pelo painel, trocar por uma nota (o painel restaurado mantém o acesso pelo IP **ativo** enquanto o domínio não aponta para a VPS nova e avisa no resultado; depois do DNS, desativar de novo em Configurações → Domínio do painel). **Manter o aviso original e o caminho `reativar-acesso-ip.sh`** para quem restaura com `restaurar-painel.sh`, que herda `ipAccessDisabled`. Mudar o A antes do passo continua sendo opcional.
6. **Passo 7, seção "Projects that do not come from GitHub" inteira** (âncora `projetos-fora-do-github`, os passos manuais com `tar`/`cp`/`chown` e a nota sobre `source_outside_projects_dir`): **remover**, inclusive o passo de apagar o `.env` gerado, porque agora o código faz isso (no modo upload, o `.env` que começa com o cabeçalho "Gerado pelo painel" não volta; um `.env` escrito pelo dono fica). No lugar, uma frase: marque "Publicar … antes de restaurar" também nesses projetos; o painel devolve o código à pasta de origem (que precisa estar dentro da pasta de projetos da VPS nova e sem link simbólico para fora; se a pasta já existir com arquivos, ela é mantida) e publica. A pasta de projetos precisa permitir escrita ao usuário do painel (10001).
7. **Verificações finais, item "Automatic backups are still on"**: trocar por: os projetos e o e-mail ficam com a agenda em pausa até os dados voltarem (aviso na tela); conferir que a pausa sumiu depois de restaurar cada um. Remover a frase de que a agenda pode desligar o automático do projeto sem containers.
8. **"Se algo falhar"**: o item "download falha no passo 7 ou 8: chaves antigas" perde a causa principal na restauração pelo painel; **manter** para token revogado/errado e para quem usou `restaurar-painel.sh`.
9. **Mensagens novas que o guia pode citar** (servidor, em português): "Em pausa: o painel foi restaurado e os dados deste item ainda não voltaram nesta VPS…", "As chaves do armazenamento externo que você configurou nesta VPS … foram mantidas…", "O painel antigo tinha o acesso pelo IP desativado. Aqui ele fica ativo…" e, no kit, a seção "O QUE ESTE KIT NÃO TEM".
10. **Página de solução de problemas / `production`**: documentar `ALLOWED_ORIGINS` (vazio por padrão; `.env` + `docker compose up -d`; ver `docs/internal/allowed-origins.md`) para quem usa o painel atrás de outro proxy e recebe `403 forbidden_origin`.
11. **Tabela "O que volta"**: acrescentar que as **configurações de backup** (agenda, frequência, cópias, senha dos backups) voltam com o painel, **exceto as chaves e o endereço do armazenamento**, que ficam as desta VPS.
12. **Guias de backup e de operação**: documentar a pausa de até 7 dias da agenda de projetos e e-mail depois de restaurar o painel numa VPS nova (liberam ao restaurar os dados do item, ao fazer um backup à mão, ou sozinhos em 7 dias; na mesma VPS, o que já tem containers não é pausado), a mensagem "Em pausa" na tela, e a regra do painel novo (sem projetos, sem backup feito aqui e sem backup do e-mail concluído: não envia o agendado enquanto o armazenamento tiver backups do painel; solta sozinha 7 dias depois da conexão e notifica).
13. **Kit de recuperação**: o passo 5 do kit foi atualizado (não diz mais que o painel publica "o código do GitHub"; diz que publica do GitHub ou a partir do código do backup). Qualquer trecho do guia que copie esse passo deve acompanhar.
