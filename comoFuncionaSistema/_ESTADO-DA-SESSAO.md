# Estado da sessão — 28/09/2026 (atualizado ao fim da sessão)

Documento de retomada. Se você é um agente entrando agora, leia este arquivo
primeiro e depois `index.json`. Ele diz **onde o trabalho parou**, o que está
pendente e por quê — informação que não está no código nem no git log.

> Este repositório vai ser público. Não registre aqui IP da VPS, token de setup,
> senhas nem nomes de clientes.

---

## Atualização de 29/09/2026 (leia antes do resto)

- **PRs #31, #32 e #33** depois do documento abaixo:
  - **#31** — o pedido de senha era cancelado no mesmo instante: o compose repassava
    `PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS` vazia e `Number("")` é 0. Agora: variável
    numérica vazia vale o padrão; o painel **não desiste sozinho** da senha (padrão sem
    prazo); campo de senha no alerta com Enviar/Cancelar; alerta sobrevive à queda do WS;
    digitação com o WS caído é avisada; tela limpa ao reconectar.
  - **#32** — Fase 01 só trava o root com chave **e** senha do usuário (usuário criado
    pela fase nasce sem senha → ficaria sem sudo); a varredura informa senha/chaves de
    cada usuário com sudo; card da Fase 01 curto, com quadro "o que vai acontecer".
  - **#33** — Fase 02 com `AllowTcpForwarding local` (com `no` o túnel do README deixava
    de abrir após a fase — visto em campo) e `TCPKeepAlive no`; o wizard passa `--user`
    à Fase 02; **nova Fase 07** (recomendações do Lynis seguras de automatizar — lista do
    que fica de fora e por quê em `seguranca/conceito-fases.json`); checks de Docker
    reconhecem os containers do próprio painel como risco aceito; alerta de teste de
    acesso usa o IP da VPS (não `localhost`) e não diz mais "criou o usuário";
    aviso de que a nota final do Lynis leva 2–5 min.
- **Validação real:** hardening 00–06 aplicado na VPS de teste; Lynis 76. O operador
  corrigiu à mão o túnel (`AllowTcpForwarding local` em `10-local-override.conf`).
  Próximo passo dele: **reinstalar o sistema** e refazer tudo pelo README, agora com a
  Fase 07, cronometrando.
- **Pendente:** o teste do PTY real ainda falha às vezes na CI (comando simples sem
  resposta em 30 s; não reproduz localmente em 15 repetições). Proposta: o erro de
  tempo esgotado passar a mostrar o fim da saída do terminal, para diagnóstico.
  Decisão do produto ainda aberta: acesso ao painel por túnel ou por HTTPS
  (`sslip.io` + Let's Encrypt) — hoje a porta do painel fica aberta na internet mesmo
  com o UFW, porque o Docker publica portas por fora dele.

---

## Onde tudo está

| | |
|---|---|
| Repositório | `github.com/kelvindk9w/tws-panel` |
| Branch de desenvolvimento | `dev` (default do repo) |
| Branch de instalação | `main` — protegida, só entra por Pull Request |
| Último PR mesclado | **#29** (squash) |
| PRs abertos | nenhum |
| Sincronização | `dev` e `main` com o **mesmo conteúdo** |

A `main` é o que o README manda clonar. O Passo 6 do README manda o operador
conferir `git diff --stat origin/main origin/dev` e esperar saída **vazia** —
então todo trabalho relevante na `dev` precisa ser promovido, senão quem segue o
README vê diferença e trava.

## Situação da validação real (VPS de teste)

O dono do produto está validando o painel **seguindo o README literalmente**,
numa VPS Contabo com Ubuntu 24.04.5 LTS, como um leigo faria. É daí que saiu
quase todo o trabalho desta sessão.

Estado da VPS no fim da sessão:

- Usuário `kelvin` (uid 1001) criado pelo Passo 3, com `sudo`. **Removido do grupo
  `docker`** (o instalador antigo o colocava lá — ver lições). Existe também um
  usuário `ubuntu` com sudo, vindo da imagem do provedor.
- Chave SSH `id_ed25519` instalada com `ssh-copy-id`.
- Painel **reinstalado do zero** com o instalador novo, respondendo:
  terminal `kelvin`, modo **`senha`**, porta da VPS **9001**, chave padrão.
  Projetos em `/opt/tws-projects`.
- Acesso pelo túnel: `ssh -L 9001:localhost:9001 kelvin@<ip>` e
  `http://localhost:9001/?token=<token>`.
- Wizard parado na etapa **Segurança**. A **Fase 00** precisa ser rodada de novo
  (a primeira execução morreu no meio — ver lições). O `full-upgrade` em si
  terminou no host; os passos seguintes da fase (unattended-upgrades,
  needrestart) não chegaram a rodar.
- Duas varreduras de segurança falharam por **tempo esgotado aguardando a senha
  do sudo**: o pedido não foi percebido. Corrigido no PR #28 (faixa fixa,
  contagem regressiva, título da aba).
- O usuário acrescentou uma linha `127.0.1.1 <hostname>` ao `/etc/hosts` por
  sugestão errada minha (o nome já estava lá). Redundante e inofensiva.
- No fim da sessão ele estava rodando
  `cd /opt/tws-panel && sudo git pull && sudo docker compose up -d --build`
  para pegar os PRs #28 e #29.

**Plano do usuário:** terminar esta rodada (hardening + admin + deploy), e só
então **reinstalar o sistema operacional** e refazer tudo do zero pelo README,
cronometrando, como validação final.

---

## O que foi feito nesta sessão (PRs #13 a #29)

### Instalação e README
- **#13** — README à prova de instalação real (erro de host key separado do
  reinício, `adduser`/`usermod` como par inseparável, reconectar depois do
  `usermod`, git já instalado pelo provedor). Correção da corrida na auditoria.
- **#20** — O instalador **para** antes de instalar se houver
  `/var/run/reboot-required`. Escolha da chave SSH virou regra objetiva
  (`id_ed25519` → `id_rsa` → gerar nova) e o comando sempre usa `-i`.
- **#21** — Instalador pergunta usuário do terminal, modo de execução como root e
  nome da chave local. Novo `scripts/uninstall.sh` (lista, pede para digitar
  `remover`, `--dry-run`, `--keep-repo`, diz o que **não** desfaz).
- **#22** — O instalador **não coloca mais ninguém no grupo `docker`**; se o
  usuário do terminal já estiver lá, explica e pergunta se remove.
- **#25 / #26 / #27** — Porta do painel: 4ª pergunta do instalador, confere se
  está livre na VPS e recusa 22/80/443/portas de e-mail. README ensina a conferir
  a porta livre **no computador do operador** (Linux/WSL, macOS, PowerShell)
  antes de instalar. O banner explica que o número do endereço é o da **esquerda**
  do túnel.

### Terminal ao vivo
- **#14** — Varredura detecta o usuário não-root do grupo sudo; Fase 01 vem
  preenchida e a chave SSH ficou opcional.
- **#15** — Botão "Abrir como `<usuário>`" (`su -`) nas sessões root.
- **#21** — Terminal abre com o usuário escolhido na instalação
  (`PAAS_TERMINAL_USER`) e dois modos (`PAAS_ROOT_MODE`):
  - `senha` (recomendado): `sudo` no próprio terminal, o operador digita a senha;
  - `segundo-plano`: comandos de root pelo host bridge, auditados, saída espelhada.
  O monitoramento agendado roda como root nos dois modos. Protocolo de controle
  no WebSocket (NUL + `paas-control:` + JSON) e `GET /api/terminal/info`.
- **#22** — O painel verifica a cada sessão se o usuário do terminal consegue
  escrever no socket do Docker (= root sem senha) e mostra aviso vermelho.
- **#23** — Aviso de conexão não protegida com saída pronta (comando do túnel e
  URL `localhost` montados); textos da chave pública e da simulação.
- **#28** — Pedido de senha impossível de perder: faixa fixa no topo, contagem
  regressiva (viaja como duração, não como instante), título da aba, prazo de
  5 → 2 min (`PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS`), texto dizendo que a senha
  é do usuário do terminal, **não** do root.

### Hardening
- **#14** — Confirmação de acesso da Fase 01 passou a vir do marcador
  `:::PAAS_ROLLBACK_SCHEDULED`, emitido só quando uma reversão é de fato agendada.
- **#24** — As fases não derrubam mais o próprio canal:
  - Fase 00 segura (`apt-mark hold`) os pacotes que reiniciam o Docker e devolve o
    estado por `trap`; unattended-upgrades exclui o Docker.
  - `NEEDRESTART_MODE=l` em todas as fases.
  - Fase 05 preserva Docker instalado via snap e simula o `autoremove` antes.
  - **Execução destacada**: `setsid` + `flock` por fase + log/código de saída em
    arquivos de estado; o painel reataja e reconcilia após queda do canal ou
    reinício do próprio painel. Allowlist reconstrói o comando e compara byte a
    byte.

### Deploy e projetos
- **#15** — `git` instalado na imagem (o modo git **nunca** tinha funcionado) e
  erro de binário ausente com mensagem legível.
- **#16** — Repositório privado com credencial de leitura cifrada (AES-256-GCM,
  chave própria), entregue ao git por `GIT_ASKPASS` — nunca na URL nem no argv.
  Diretório dos projetos configurável (`PAAS_PROJECTS_DIR`, montado com o mesmo
  caminho dentro e fora do container).
- **#19** — Gravação em disco que falha não é mais confirmada (senha, sessões,
  credencial). Regra de banco exposto reconhece `"5432"`, `${VAR}:5432`, faixas,
  IPv6 e forma longa; lista de bancos unificada. Migração para o Vitest 4.
- **#21** — Caddy e Stalwart recebiam a configuração por bind mount de caminho
  que só existe dentro do container: **não funcionavam em nenhuma VPS**. Agora a
  config é gravada dentro dos containers com `docker cp`.

### Saúde e monitoramento
- **#20** — O monitoramento agendado **vigiava o container, não a VPS**
  (`HostRunner` local). Corrigido para o host bridge, com recoleta da linha de
  base antiga sem alertas falsos. Tela de saúde: todos os cards com selo, IP do
  container removido, reinicialização pendente, KVM reconhecido.

### CI e testes
- **#16** — Lacunas reais de cobertura fechadas em vez de baixar limites.
- **#19** — Vitest 4 com classificação trecho a trecho do que a nova régua passou
  a contar; só um limite recalibrado, com justificativa no config.
- **#29** — Teste do PTY real estabilizado: o `docker exec` devolve o stream antes
  de o shell existir; o teste agora espera prontidão antes de medir.

---

## Pendências — o que fazer a seguir

### Com o usuário, agora
1. Depois do `git pull` + `docker compose up -d --build`: **Revarrer** na etapa
   Segurança, digitar a senha do `kelvin` quando o pedido aparecer, e rodar a
   **Fase 00** de novo. Conferir no log os pacotes do Docker que ficaram de fora.
2. Fases 01–03 aplicadas de verdade: quando o painel pedir confirmação de acesso,
   **abrir uma janela SSH nova sem fechar a atual** e testar o login antes de
   confirmar (janela de 5 minutos, depois reverte sozinho).
3. Criar a conta admin, depois deploy de **repositório público** e só então de
   **privado** — para saber qual parte quebrou, se quebrar.
4. Ainda não recebi o print do pedido de senha que ele descreveu como "senha
   root" pelo IP. Com o #28 no ar, confirmar se o problema sumiu.

### Itens de interface pedidos e ainda não feitos
- Fase 01: deixar explícito que **sem chave o operador digita a senha quando
  necessário**, e botão "como instalar a minha chave" ao lado do "como gerar".
- Botão "O que isso faz?" expansível junto de "Simular todas as fases pendentes".
- Botão **verde** "Aplicar de verdade", com texto objetivo de que agora a VPS
  será alterada.

### Decisões pendentes do usuário
- **HTTPS com certificado próprio na instalação** (primeiro acesso pelo IP já
  criptografado, impressão digital no banner). Proposto, sem resposta.
- **Banco publicado só em loopback** (`127.0.0.1:5432:5432`) hoje é bloqueado.
  Opções: manter; rebaixar para aviso (recomendado); liberar.
- **Suporte ao Ubuntu 26.04**: rodada dedicada depois de o 24.04 estar validado.

### Limitações e riscos conhecidos
- `/security/hardening` (fora do wizard) não exibe terminal, e o terminal só
  conecta com o setup token: no modo `senha`, varredura/fase disparada ali pede a
  senha num terminal invisível e expira.
- Logs de execução das fases (`/etc/paas/runs`) são legíveis por qualquer usuário
  local (`umask 022`, para o usuário do terminal acompanhar sem senha).
  Restringir ao usuário do terminal.
- O Docker ficou **sem atualização automática de segurança** (troca consciente
  para o painel não cair de madrugada). README e log da Fase 00 avisam.
- `alerts-service` ainda engole falha de gravação (os outros stores já não).
- O painel não exibe o diretório de projetos em uso.
- Achados antigos ainda abertos: Stalwart `v0.11.8` com CVE-2025-61600 (P1
  pós-lançamento); Trivy deixa passar HIGH; imagem de produção carrega
  devDependencies; `intervalMs` do monitor auditado sem o clamp.
- `global/threat-model.json` ainda descreve "terminal web com root" como risco
  aceito — precisa refletir os modos `senha`/`segundo-plano` e o risco do grupo
  `docker`.

### Divulgação
- Thread publicada no X (5 tweets, sem link do repositório). O próximo post
  combinado é a **continuação da história** (resultado da validação), não uma
  repetição. O link do repositório só entra depois da validação final.

---

## Lições desta sessão (evitar repetir)

- **O painel roda DENTRO de um container. Toda funcionalidade que toca o host
  precisa ser pensada dos dois lados.** Esta sessão achou quatro defeitos graves
  com a mesma raiz, nenhum pego por teste porque em desenvolvimento o painel roda
  direto no host:
  - bind mount de caminho do painel (`/data/...`) é resolvido pelo daemon **no
    host**, onde não existe — Caddy e Stalwart nunca funcionaram numa VPS;
  - `os.networkInterfaces()` mostra a rede do container, não a da VPS;
  - `HostRunner` (`bash -c` local) roda no container — o monitoramento vigiava o
    próprio painel;
  - qualquer coisa que reinicie o `dockerd` (upgrade do `docker-ce`, `needrestart`,
    remover snap do Docker) mata o PTY e o helper **no meio da fase**.
  Pergunta obrigatória em code review: *isto roda no container ou no host, e o
  caminho/processo existe dos dois lados?*
- **Grupo `docker` = root sem senha.** Qualquer proteção baseada em "o usuário não
  é root" é falsa se ele estiver no grupo. Verificar pela permissão real de
  escrita no socket, não pelo nome do grupo.
- **Teste de `sudo` precisa separar digitação de execução.** Medi `time sudo true`
  com a credencial fora do cache e atribuí à rede o tempo que era a pessoa
  digitando. Medir sempre com credencial em cache (`sudo -v` antes).
- **"Lento" pode ser "esperando por alguém".** Os 296 s do relato eram o timeout
  de senha, visível no log como `SudoElevationError reason:"timeout"`. Leia o log
  com o campo `host` de cada requisição antes de concluir onde algo aconteceu.
- **O túnel SSH tem duas portas.** `ssh -L <local>:localhost:<vps>` —
  `Address already in use` é o lado esquerdo (computador do operador);
  `Connection refused` é o direito; o navegador usa sempre o número da esquerda.
- **Não aceite de subagente uma redução de escopo que contraria pedido explícito
  do usuário.** O usuário pediu um comando para achar porta livre; o agente
  decidiu não publicar "porque não existe um igual nos três sistemas" e eu
  repassei. A resposta certa era publicar os três.
- **Verifique pessoalmente as afirmações de segurança dos subagentes** (onde o
  segredo trafega, allowlist, quoting). Em todas as vezes nesta sessão bateu,
  mas é a parte que não pode estar errada.
- **Remover uma trava de interface pode expor um defeito que ela escondia.** Ao
  tornar a chave opcional na Fase 01, apareceu que o executor decidia a
  confirmação de acesso pelo argumento, não pelo que o script fez.
- **Teste instável tem causa.** O do PTY real falhou três vezes; subir o timeout
  já tinha sido tentado. A causa (escrever antes de o shell existir) só apareceu
  olhando o fluxo cru. Não usar retry automático onde ele esconde o defeito que o
  teste existe para pegar.

## Detalhes que custaram tempo e vale saber de antemão

- **Todo PR `dev` → `main` nasce `CONFLICTING`** por causa do squash merge. O
  procedimento, sempre com verificação antes:
  1. `git fetch origin` e conferir que `git diff origin/dev origin/main` só tem,
     do lado da `main`, versões antigas do que a `dev` reescreveu (nenhum arquivo
     só na `main`: `git diff origin/dev origin/main --name-status | grep '^A'`
     vazio). Para JSON reformatado, comparar o conteúdo parseado, não linhas.
  2. `git merge -s ours origin/main -m "chore: reconcile with main after squash merge"`
  3. `git diff <commit anterior> HEAD --stat` **vazio** (a árvore não mudou).
  4. `PAAS_SKIP_PREPUSH=1 git push origin dev` e esperar a CI de novo.
- **Hook de pré-commit barra segredos em testes também.** Fixtures não podem
  parecer tokens reais (`github_pat_…`). A chave de exemplo oficial da AWS
  (`AKIAIOSFODNN7EXAMPLE`) está na allowlist como string exata; o cabeçalho de
  chave privada é montado por concatenação no teste.
- **Vitest 4:** mock de classe usado com `new` precisa de `function`, não arrow;
  a cobertura remapeada por AST conta callbacks defensivos que a v3 ignorava.
- **Corpo de PR com caractere de controle é recusado pela ferramenta** — usar
  `gh pr create --body-file`.
- **`gh run view --log-failed` pode vir vazio**; usar
  `gh api repos/kelvindk9w/tws-panel/actions/jobs/<id>/logs`.
- **A ferramenta bloqueia `sleep N && cmd`**; esperar condição com
  `until <cheque>; do sleep 20; done`.
- **A `main` é protegida** (`protect-main`); push direto é rejeitado. Nunca
  contornar.
- **Drop-in de sshd: o primeiro arquivo vence.** Override do usuário em
  `10-local-override.conf`; verificar com `sudo sshd -T | grep -i clientalive`.
- **Squash merge invalida verificação por ancestralidade** (`A..B` mente neste
  repo); compare conteúdo com `git diff --stat`.

## Convenções observadas

- Commits em português, conventional commits, corpo explicando **por quê** e o
  comportamento (não as linhas). Trailer de coautoria e link da sessão no fim.
- PR com contexto do problema real, decisões, trade-offs honestos e validações.
- Comentários no código em português, densos, explicando a decisão.
- TDD: teste que falha primeiro, verificado falhando pelo motivo certo.
- Nunca commitar sem `pnpm test:coverage` (espelha a CI) e `pnpm run typecheck`
  limpos; scripts com `bash -n` e `npx --yes shellcheck -x`.
- Subagentes com escopo de escrita explícito por arquivo; em paralelo só em
  arquivos disjuntos; nunca `git stash`/`reset`/`checkout` dentro deles.
- `comoFuncionaSistema/` atualizado junto com o código.
- O usuário não quer código colado no chat — cite o caminho do arquivo.
- Público-alvo do README é o leigo: nada pode depender de sorte nem de a pessoa
  ler uma mensagem solta na tela; transparência total (projeto open source).
- `image1.png`/`image2.png` na raiz são prints do usuário com IP da VPS: **nunca
  commitar**.
