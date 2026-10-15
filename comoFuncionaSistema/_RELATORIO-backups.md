# Relatório — Backups, fase 1 (14/10/2026, branch `feat/backups`)

Backups automáticos do painel, do e-mail e dos bancos e arquivos de cada
projeto. Uma cópia fica na VPS e outra pode ir para um armazenamento externo
(Cloudflare R2 ou outro compatível com S3), cifrada e conferida. Comportamento
e API em `backups/` (index.json e um JSON por endpoint).

## O que mudou (pelo comportamento)

### Configurações → Backups (`/settings/backups`)
- **Armazenamento externo.**
  - Escolha entre Cloudflare R2 (marcado como recomendado) e "Outro compatível com S3" (Backblaze B2, Contabo, MinIO, Amazon S3).
  - Para o R2, a tela mostra o passo a passo. Os campos são endpoint, bucket, região (R2: `auto`), Access Key ID e Secret Access Key.
  - **Testar e salvar**: antes de guardar, o painel grava, lê e apaga um arquivo pequeno no bucket. Se falhar, nada é salvo e a tela explica o motivo (chave recusada, bucket inexistente, sem resposta).
  - O endpoint pode ser colado do jeito que o Cloudflare mostra, com o bucket no fim: o painel tira o bucket sozinho.
  - Conectado: aparecem o bucket, o endpoint, o fim da chave de acesso e o selo "Testado em…". Botões **Testar conexão**, **Editar** e **Desconectar** (pede confirmação; os arquivos que já estão lá continuam lá).
  - A chave secreta fica cifrada no servidor e não volta para a tela.
- **Criptografia da cópia externa.**
  - Vem ligada. A frase da LGPD explica por que cifrar. **Desligar a criptografia** pede confirmação e avisa que os próximos backups externos vão sem senha.
  - Sem senha definida, aparece a **tela de ativação destacada** (borda laranja):
    - o alerta "Sem esta senha, ninguém, nem a TWS, consegue abrir seus backups.";
    - o campo da senha (mínimo 12 caracteres) e a força medida enquanto a pessoa digita;
    - **Sugerir uma frase forte**: 6 palavras e um número, como `girafa-lunar-pomar-tijolo-vento-cedro-512`;
    - **Baixar kit de recuperação**: um `.txt` com a senha, onde os backups ficam e como restaurar com o painel, numa VPS nova e sem o painel (7-Zip, Keka, `.sql`, `tar`);
    - a caixa obrigatória **Guardei a senha em lugar seguro**. Só com ela marcada o botão **Ativar a criptografia** funciona.
  - Com senha definida:
    - **Testar minha senha** abre um arquivo pequeno cifrado guardado no armazenamento e diz se a senha está certa;
    - **Ver a senha** pede a senha de login. Fica registrado na Auditoria e tem limite: depois de 5 tentativas erradas, espera de 15 minutos. A resposta não fica em cache;
    - **Trocar a senha** avisa: os backups novos usam a nova, e os antigos continuam abrindo só com a antiga.
  - **Lembrete trimestral**: a cada 90 dias sem teste certo, a página mostra "Você ainda tem sua senha de backup? Teste aqui" e sai uma notificação.
- **Painel** e **E-mail**, um cartão para cada um:
  - backup automático ligado ou desligado;
  - frequência: uma vez por dia, a cada 12 ou a cada 6 horas;
  - quantas cópias ficam na VPS (padrão 2) e fora (padrão 5);
  - a frase "Roda às 03:00 (horário da VPS, UTC-03:00) e depois a cada N horas. Seus backups cobrem os últimos X dias no armazenamento externo e as últimas Y horas na VPS.";
  - o último backup com o estado, o motivo quando falhou, a última cópia externa conferida e o próximo horário;
  - **Fazer backup agora** e **Restaurar**.
  - Sem o servidor de e-mail instalado, o cartão E-mail só diz isso e leva para a página E-mail.
- **Projetos**: a lista dos projetos com o estado do último backup e o botão **Abrir**, que leva à aba Backups de cada um.
- **Restaurar de outro servidor**: o fluxo da VPS nova, em três passos.
  1. Conectar o mesmo armazenamento.
  2. Informar a senha antiga. O painel confere a senha no arquivo que a VPS antiga deixou no armazenamento antes de usá-la.
  3. **Ver o que existe no armazenamento**, que lista painel, projetos e e-mail na ordem certa, cada um com o botão Restaurar.
- **Últimos backups**: backups e restaurações com a data, o tamanho, onde ficaram ("na VPS · cópia externa conferida") e o motivo de falha ou aviso.
- Sem o 7-Zip no container, uma faixa vermelha avisa que os backups não rodam e mostra como atualizar.
- Com algo rodando, a página se atualiza sozinha a cada 3 s e mostra "Fazendo backup de X; N na fila".

### Aba **Backups** do projeto (`/projects/:id/backups`)
- **O que entra no backup**: o painel olha os containers depois de cada deploy que dá certo.
  - **Bancos de dados**: são detectados pela imagem (PostgreSQL, MySQL, MariaDB, MongoDB, Redis). A tela mostra o banco e o usuário lidos do ambiente e explica como o backup é feito. Vêm marcados, menos o Redis ("costuma ser cache").
  - **Volumes e pastas**:
    - cada um aparece com o tamanho, o volume ou a pasta do servidor e o motivo de vir marcado ou não;
    - a pasta de dados do banco aparece desabilitada: "Coberto pelo dump do banco";
    - vêm marcados os nomes de upload, storage, media e dados;
    - vêm desmarcados os caches, temporários, logs, `node_modules`, `.next` e os arquivos únicos de configuração.
  - **Código do projeto**: só aparece nos projetos que não vêm do GitHub (envio ou pasta do servidor). Vem marcado.
  - **Pastas adicionadas**: escolhe-se o serviço e o caminho dentro do container, depois **Adicionar pasta**.
  - **Arquivos gravados fora de volume** (aviso laranja): mostra o serviço, quantos arquivos são e exemplos. Explica que eles somem no próximo deploy e como resolver.
  - **Salvar itens** grava as escolhas de uma vez. **Detectar de novo** refaz a leitura.
- **Frequência e cópias**: os mesmos controles do painel, com a frase de cobertura, mais **Fazer backup agora** e **Restaurar**.
- **Histórico** do projeto.

### Restaurar (janela igual para projeto, painel e e-mail)
- Aviso do que acontece:
  - projeto: os dados voltam àquela data e o app fica parado;
  - e-mail: para por instantes;
  - painel: volta inteiro e reinicia.
- Lista de datas com tamanho e selos "Na VPS" e "Externo". Quando a data existe nos dois, dá para escolher a cópia (a da VPS é mais rápida).
- Na cópia externa, o link "Este backup é de antes de uma troca de senha?" abre um campo para a senha da época.
- No projeto, a caixa **Publicar do GitHub antes de restaurar** serve à VPS nova, quando o projeto ainda não tem containers.
- Para confirmar, digite o nome do projeto, `painel` ou `e-mail`. Maiúsculas e minúsculas tanto faz.
- Depois de confirmar, a janela mostra as etapas com o andamento ("Restaurar o banco db (PostgreSQL)"…). Dá para fechar, porque a restauração continua no servidor.

### Criação do projeto
- O passo 2 de Novo projeto tem **Fazer backup: Sim / Não**, com Sim marcado. O que entra é decidido depois, na aba Backups.

### Roteiro de primeiros passos, passo 6: "Backups fora da VPS"
- É opcional e tem "Não vou usar".
- O "Como fazer" mostra o passo a passo do R2 e o botão **Abrir Backups**.
- O passo conta como feito com o armazenamento conectado e pelo menos uma cópia externa conferida.

### Notificações (tipos novos, ligados por padrão)
- **Backup falhou**: quando um backup falha ou quando a cópia externa falha.
- **Backup externo atrasado**: nenhuma cópia externa conferida há mais de 2 dias, ou 2 vezes a frequência se for maior. No máximo um aviso por dia por item.
- **Lembrete da senha de backup**: a cada 90 dias.

## Como o backup roda (resumo técnico)

1. **Fila**: um backup ou restauração por vez, em segundo plano, sem travar o painel. Pedir o mesmo item duas vezes não duplica.
2. **Agenda**: o painel confere a cada minuto. O horário base é **03:00 no fuso da VPS** e depois a cada 24, 12 ou 6 h. Se o painel estava desligado no horário, o backup roda uma vez quando ele volta.
3. **Espaço em disco**: antes de começar, o painel confere se cabe. A conta é tamanho × 2,2 (só na VPS), × 2,4 (externo sem senha) ou × 3,2 (externo cifrado), mais 256 MB, mantendo 5% do disco livre. Se não couber, o backup falha com a conta na mensagem e nada é apagado.
4. **Bancos**: o dump roda **dentro do container do banco**, com as credenciais do ambiente dele (inclusive `*_FILE`).
   - **PostgreSQL**: um `.sql` por banco (`pg_dump --clean --if-exists`) e `_papeis.sql` (`pg_dumpall --globals-only`).
   - **MySQL / MariaDB**: `mysqldump` ou `mariadb-dump` com `--add-drop-database --databases`, sem os bancos de sistema. A senha vai por `MYSQL_PWD`.
   - **MongoDB**: `mongodump --archive`. A senha vai num arquivo `--config` temporário (decisão 13).
   - **Redis**: `redis-cli SAVE` e cópia de `/data`. A senha, quando existe, vai pela variável `REDISCLI_AUTH`.
5. **Pastas e volumes**: `docker cp` gera um `.tar`, que guarda dono e permissões.
6. **Compactar**: `7zz a` (`-mx=5`). Junto vão um `LEIA-ME.txt`, que explica cada arquivo, e um `manifesto.json`, que é o que a restauração lê.
7. **Cópia na VPS**: sempre, **sem senha**, em `data/backups/<pasta>/AAAA-MM-DD_HH-MM.7z`. No host fica em `/var/lib/docker/volumes/paas_data/_data/backups/`. O painel guarda as N mais recentes.
8. **Cópia externa**:
   - com criptografia, é um **segundo arquivo** gerado das mesmas entradas, com `-p -mhe=on` (AES-256, e os nomes dos arquivos também ficam cifrados). Sem criptografia, sobe o mesmo arquivo da VPS;
   - arquivos acima de 64 MB sobem em partes de 32 MB;
   - o caminho no bucket é `TWS Panel Backups/<nome-do-projeto>/AAAA-MM-DD_HH-MM.7z`, `…/_painel/` e `…/_email/`. O nome do projeto é o slug: sem acentos nem espaços.
9. **Conferência**: o painel baixa a cópia de volta, compara o SHA-256 e abre com `7z t`. Só depois disso apaga as externas além das N mais recentes. Se a conferência falhar, nada é apagado fora e sai o aviso "Backup falhou".
10. **Temporários**: tudo é feito em `data/backups/.tmp/`. A pasta é apagada no fim de cada operação e a cada subida do painel.
11. **Prazos**: cada comando do Docker tem até 2 h e cada operação do 7-Zip até 4 h. Passou disso, o comando é interrompido e o backup vira falha.

## Decisões (e onde o pedido foi seguido de um jeito específico)

1. **7-Zip dentro da imagem do painel.**
   - O `Dockerfile` instala o pacote `7zip` do Debian bookworm, que traz o binário `7zz`. Num container `debian:bookworm-slim` veio a versão 26.02.
   - Foi descartado um container auxiliar só para o 7-Zip: ele precisaria de uma imagem a mais baixada na VPS, e os arquivos já estão no volume do painel.
2. **A senha nunca vai pela linha de comando.**
   - O `7zz` recebe a senha pela entrada padrão: com `-p` sem valor, ele pergunta e lê uma linha.
   - Por isso ela não aparece no `ps` do host, em log nem na auditoria. A auditoria registra só "senha definida/trocada/vista/testada".
   - O script `scripts/restaurar-painel.sh` faz igual: lê com `read -s` e passa por `printf | docker run -i`.
3. **Dois arquivos quando a criptografia está ligada**: o da VPS, sem senha, para restaurar rápido; e o externo, cifrado. Sem criptografia, um arquivo só sobe.
4. **E-mail: o Stalwart para durante a cópia.**
   - O painel faz `docker stop -t 30`, copia o volume de dados e a pasta de configuração, e faz `docker start`.
   - O export nativo do Stalwart não foi usado: ele exporta conta por conta e não leva as configurações nem as chaves DKIM. A cópia parada traz tudo de forma consistente.
   - Com o Stalwart real, a parada leva poucos segundos. No teste, com um container de mentira que demora a responder ao sinal, levou 30 s.
   - O webmail (Roundcube) é copiado sem parar.
5. **Painel: restauração em duas fases.**
   - O painel não troca o próprio estado com tudo rodando, porque cada serviço gravaria de novo o que tem em memória.
   - Primeiro ele extrai o backup em `data/backups/.restaurar-painel/`, grava um marcador e reinicia (o Docker sobe de novo com `restart: unless-stopped`).
   - Na subida, **antes de qualquer serviço ler o disco**, ele guarda o estado atual em `data/backups/_painel/antes-da-restauracao/` e põe o backup no lugar.
   - Ficam como estão: as cópias de backup, o `setup-token` desta instalação e a pasta `projects/` das instalações antigas.
   - **Permissões**: o 7-Zip guarda e devolve o modo de cada arquivo (conferido: 0600, 0700 e 0640 voltam iguais). Um `.7z` refeito no Windows, porém, chega sem esse dado. Por isso a troca deixa tudo o que volta só para o dono: arquivos 0600 (0700 se eram executáveis) e pastas 0700. Links simbólicos não são seguidos. O dono é o usuário do painel (10001), porque é ele quem extrai, tanto pela tela quanto pelo script por SSH. O script também extrai com `umask 077`.
6. **O backup do painel inclui as chaves que cifram os segredos** (2FA, tokens, chave do armazenamento, `backups-key`). Quem abre esse `.7z` tem tudo. É por isso que a cópia externa vem cifrada e a tela recomenda manter a criptografia.
7. **Fuso da VPS.**
   - Montar `/etc/localtime` por cima do arquivo do container **não funciona** no Node: testado, continuou em UTC.
   - Foi feito assim: o compose monta o `/etc/localtime` do host em `/host/etc/localtime` (somente leitura). Na subida, `services/host-timezone.ts` acha o nome do fuso comparando o conteúdo com `/usr/share/zoneinfo` e define `TZ`.
   - Fusos sem horário de verão e com tzdata diferente viram `Etc/GMT±N`. `TZ` no `.env` tem prioridade.
   - Testado num container `node:22-bookworm-slim` com o arquivo de `America/Sao_Paulo`: deu `America/Sao_Paulo` e deslocamento de 180 min.
8. **Projetos que não vêm do GitHub** (envio ou pasta do servidor): a pasta do código entra no backup, marcada por padrão. **Isto diverge do "não fazer backup do código"**: nesses projetos o código só existe na VPS.
9. **"Testar minha senha"** usa um arquivo pequeno cifrado, `TWS Panel Backups/_verificacao/senha.7z`. Ele é gravado ao definir a senha e ao conectar o destino. Numa VPS nova, sem senha guardada, o teste abre esse arquivo sem regravá-lo. Assim a senha antiga é conferida antes de ser usada.
10. **Pasta no destino = slug do projeto**: o nome do projeto sem acentos e sem espaços. Projetos com o mesmo slug em duas instalações dividiriam a pasta. Por isso o ideal é um bucket por painel.
11. **Restaurar projeto numa VPS nova**: com "Publicar do GitHub antes de restaurar", o painel publica o projeto e espera o deploy (até 45 min) antes de pôr os dados. Isso funciona depois de restaurar o painel, que traz os projetos cadastrados.
12. **Restauração de banco**:
    - PostgreSQL usa `--clean --if-exists`: apaga e recria os objetos que estão no dump. Tabelas criadas depois do backup e que não estão no dump continuam lá.
    - MySQL e MariaDB usam `--add-drop-database`: o banco é recriado inteiro.
    - MongoDB usa `--drop`.
    - Os avisos do banco (`ERROR`) viram "N aviso(s) do banco" na restauração, sem derrubá-la.
13. **Senha do MongoDB fora do `ps`**.
    - O `mongodump` e o `mongorestore` recebem `--config <arquivo>` em vez de `--password`. É um YAML com a linha `password: '…'`, criado com `umask 077` (0600) e `mktemp` no `/tmp` do container do banco.
    - Ele é apagado ao sair, com sucesso, com erro ou por sinal (`trap`). Aspas e caracteres especiais na senha funcionam.
    - **Fallback**: antes de usar, o painel confere se a ferramenta mostra `--config` no `--help`. As database-tools 100.3+ têm, e elas vêm nas imagens `mongo` 4.4 em diante. Nas imagens até 4.2 (ferramentas 4.2) a opção não existe, e a senha volta a ir por `--password`. Nesse caso ela aparece no `ps` do container do banco enquanto o dump roda. Para evitar, atualize a imagem do Mongo.
    - Se o painel for derrubado no meio de um dump, o arquivo pode ficar no `/tmp` do container do banco, mas com 0600 e só até o container reiniciar.
    - MySQL e Postgres usam variável de ambiente, e o Redis usa `REDISCLI_AUTH` (antes ia por `-a`).
14. **Google Drive**: ficou só a abstração (`BackupStorage` em `backup-s3.ts`, a mesma interface que um destino Drive implementaria). Não foi implementado, como pedido.
15. **Endpoint `http://`** é aceito (MinIO local), mas a tela e o kit falam em `https://`. Na internet, use sempre `https://`.

## O que foi testado de verdade

Ambiente: WSL2, Docker 29.7.2, Node 22. Tudo com contêineres e volumes de
teste com nomes próprios (`paas-e2eloja`, `paas-e2emaria`, `e2e-*`).

1. **Projeto com PostgreSQL e volume**, com o `BackupService` real, `DockerCli`, `SevenZip` (`7zz` 25.01 oficial) e `S3Storage`, contra um **S3 local (versitygw)**.
   - O MinIO não foi usado: a imagem `minio/minio` não está mais disponível no Docker Hub (acesso negado), nem em `quay.io` sem login.
   - **Dados**: Postgres 18 com 500 linhas e um segundo banco; um volume `/app/uploads` com arquivos de dono 1000:1000 e um arquivo aleatório de 80 MB, para forçar o envio em partes.
   - **Detecção**:
     - o banco `loja` e o usuário apareceram;
     - a pasta de dados do Postgres apareceu como "coberta pelo dump";
     - `/app/uploads` veio marcado e `/app/cache` desmarcado;
     - o arquivo gravado fora de volume (`/app/notas/fora-do-volume.txt`) foi apontado.
   - **Conexão e senha**: o destino foi conectado com o teste de verdade. A senha certa passou em "Testar minha senha" e a errada foi recusada.
   - **Backup cifrado**: sucesso em 19 s. A cópia externa foi enviada (em partes) e conferida com hash e `7z t`.
     - A cópia da VPS abre **sem senha**.
     - A externa **não abre sem senha, nem para listar os nomes** (`-mhe=on`), e abre com a senha.
     - O caminho no bucket ficou `TWS Panel Backups/e2eloja/2026-10-14_22-48.7z`.
   - **Dados estragados de propósito**: linhas apagadas, uma linha "intruso" inserida, o segundo banco apagado e arquivos removidos e criados no volume.
   - **Restauração a partir da cópia externa**: sucesso. Conferido:
     - 500 linhas de novo e o "intruso" sumiu;
     - o segundo banco voltou;
     - os arquivos voltaram, com o mesmo MD5 do arquivo de 80 MB;
     - o arquivo criado depois sumiu;
     - o dono 1000:1000 foi mantido;
     - os containers estavam ligados de novo.
   - **Retenção**: com 2 cópias na VPS e 2 fora, depois de mais 2 backups ficaram exatamente 2 nos dois lugares, e o mais antigo foi apagado.
   - **Painel**: backup feito e conferido. O `.7z` não tem a pasta `backups/` e tem o `backups.json`.
   - **Catálogo**: "Restaurar de outro servidor" listou o painel e o projeto.
2. **MariaDB 11.4 e Redis**, só cópia na VPS: o backup deu certo (o Redis marcado à mão). Depois de apagar linhas, inserir uma a mais e apagar a chave do Redis, a restauração trouxe as 3 linhas com acento (`olá, mundo, ação`) e a chave do Redis.
3. **E-mail com um "Stalwart" de mentira**: um alpine com o mesmo layout de volume e configuração, mais um webmail com volume.
   - O backup parou o container, copiou e ligou de novo.
   - Depois de apagar a mensagem, estragar a configuração e apagar o arquivo do webmail, a restauração trouxe os três de volta.
4. **`scripts/restaurar-painel.sh`** com Docker, volume e 7-Zip de verdade. Foi usada uma imagem de teste (`node:22-bookworm-slim` + pacote `7zip`) e um container "painel" que roda o `panel-restore.ts` real na subida.
   - Com a senha errada: o script recusa e não mexe no volume.
   - Com a senha certa: confere, para, extrai, sobe e confirma.
   - No volume: `users.json` veio do backup, o `setup-token` da VPS ficou, as cópias de backup ficaram e o estado anterior foi para `backups/_painel/antes-da-restauracao/`. Os arquivos ficaram com dono 10001.
   - Segunda rodada, com a **imagem real do painel** (`docker build` desta branch) e um `.7z` com permissões misturadas (0644, 0666, 0640, pastas 0755 e 0750). Depois da restauração, todos os arquivos ficaram 0600 e as pastas 0700, com dono 10001:10001. O `setup-token` da VPS ficou como estava.
5. **MongoDB 7 (database-tools 100.19.1) e Redis com senha**, só cópia na VPS.
   - Dados: senha do Mongo com aspas simples e duplas; 3 documentos com acento e uma coleção de 300 mil documentos (dump de 74 MB, para dar tempo de vigiar). Redis com `requirepass`.
   - Durante o backup e a restauração, um laço lia `docker top` dos dois containers sem parar. Ele viu o `mongodump` e o `mongorestore` com `--config /tmp/tws-mongo.XXXXXX` e sem `--password`. A senha do Mongo e a do Redis não apareceram em nenhuma leitura.
   - Nenhum `tws-mongo.*` sobrou no `/tmp` do container.
   - A restauração trouxe os 3 documentos (sem o "intruso"), as 300 mil linhas e a chave do Redis. O `SAVE` com `REDISCLI_AUTH` respondeu OK.
   - **Fallback**: num `mongo:4.2` (mongodump r4.2.24, sem `--config`), o mesmo script caiu na senha por argumento e gerou o dump.
6. **Pacote `7zip` do Debian bookworm** num container: o binário `7zz` existe; criar com senha pela entrada padrão, testar e extrair funcionam; a senha errada sai com código 2 e "Wrong password".
7. **Fuso**: veja a decisão 7.
8. **Telas no navegador** (Chromium headless com `playwright-core` instalado no rascunho da sessão, Vite com a API simulada), em desktop 1366 px e celular 390 px:
   - Configurações → Backups configurada;
   - a tela de ativação da senha com a sugestão e a força;
   - a aba Backups do projeto;
   - a janela de restaurar (confirmação e progresso);
   - "Restaurar de outro servidor" com o catálogo.
   - Achado e corrigido: rolagem lateral no celular (o caminho longo e o endpoint não quebravam) e o campo da senha espremido ao lado do botão "Sugerir". No fim: sem rolagem lateral e sem erro no console.

## O que NÃO foi testado de verdade

- **Cloudflare R2 real**: o cliente S3 (assinatura SigV4 própria, path-style, envio em partes) foi validado contra o versitygw e por testes unitários com as respostas do S3. Falta conectar um bucket R2 de verdade.
- **Stalwart real** (parar, copiar e subir) e Roundcube real: só com o container de mentira.
- **MySQL oficial** (a imagem `mysql`): só os scripts e os testes unitários. O MariaDB e o MongoDB foram reais.
- **A imagem `tws-panel` completa rodando como painel**: o `docker build` da imagem inteira deu certo e o `7zz` dentro dela responde (7-Zip 26.02). Mas o painel não foi posto no ar a partir dessa imagem.
- **O painel inteiro no ar** (servidor real com as telas reais) e o **reinício real do painel** depois de restaurar pelo navegador. A troca na subida foi testada com o `panel-restore.ts` real, mas o `process.kill` + `restart: unless-stopped` não.
- **"Publicar do GitHub antes de restaurar"** de verdade (deploy real numa VPS nova): só com dublê.
- **Bancos grandes** (GBs): o fluxo é em arquivo e não passa pela memória, mas não foi medido.

## Testes automáticos

- Servidor:
  - `backup-service` com 51 testes;
  - rotas, detecção, S3, agenda, 7-Zip (falso e real via `PAAS_TEST_7Z`), restauração do painel (inclusive as permissões), fuso e o script por SSH (com `docker` falso);
  - os scripts do Mongo e do Redis rodam de verdade no `sh`, com ferramentas falsas que registram os argumentos e o arquivo `--config`: sem senha na linha, arquivo 0600 que some no fim, mesmo com erro, e o fallback;
  - testes das rotas de projetos (escolha na criação, projeto apagado).
- Core: `backups.test.ts` (carimbo, cobertura, força da senha, kit), tipos novos de notificação e o roteiro com 6 passos.
- Web: Configurações → Backups (11), aba do projeto (4) e "Fazer backup: Não" na criação.
- `apps/server/src/services/backup-docker.ts` fica fora da cobertura unitária, como os outros arquivos que só falam com o Docker. Ele foi validado no teste real acima.
- Cobertura (`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`):
  - core: 78 testes passando, mínimo de 98 cumprido;
  - deploy: 99,3 / 96,64 / 99,48 / 99,69 (linhas de instruções, ramos, funções, linhas);
  - mailer: 100 / 99,4 / 100 / 100;
  - web: 697 testes passando (sem mínimo configurado);
  - server: 97,97 / 93,48 / 98,19 / 99,08 (1558 testes), medido sem `terminal-service-pty.test.ts`;
  - security: 167 testes passando.
- Suítes que falham só por depender de `docker pull ubuntu:24.04`, que é negado nesta máquina. Já falhavam antes desta branch:
  - server: `terminal-service-pty.test.ts`;
  - security: `phase01-script.test.ts` e `phase02-07-scripts.test.ts`.
- `pnpm -r run typecheck` passa limpo. O repositório não tem script de lint, nem eslint ou prettier: o CI só roda typecheck, build, testes e build da imagem.
- `docker build` da imagem inteira passou, e o `7zz` dentro dela responde.

## Passo a passo na VPS

### Atualizar o painel

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

O que conferir depois:

1. `sudo docker exec tws-panel 7zz | head -2`: tem que mostrar "7-Zip (z) …".
2. `sudo docker exec tws-panel node -e "console.log(process.env.TZ, new Date().toString())"`: tem que mostrar o fuso da VPS (ex.: `America/Sao_Paulo … GMT-0300`). Se mostrar `undefined … GMT+0000` numa VPS que não está em UTC, ponha `TZ=America/Sao_Paulo` no `/opt/tws-panel/.env` e rode o `docker compose up -d` de novo.
3. Abra **Configurações → Backups**. Não pode aparecer a faixa vermelha "O 7-Zip não está instalado".
4. Em **Painel**, clique em **Fazer backup agora**. Em alguns segundos, "Últimos backups" mostra "Concluído". O arquivo fica em `sudo ls /var/lib/docker/volumes/paas_data/_data/backups/_painel/`.

### Criar o bucket e as chaves no Cloudflare R2

1. Entre em dash.cloudflare.com, abra **R2 Object Storage** e, na primeira vez, ative o R2. Ele pede um cartão, mas o plano gratuito cobre 10 GB por mês.
2. **Create bucket**:
   - nome, por exemplo `tws-backups` (só minúsculas, números e hífen);
   - localização automática;
   - classe Standard.
3. Volte ao R2 e abra **Manage API tokens** (no canto da página do R2) → **Create API token**:
   - permissão **Object Read & Write**;
   - em "Specify bucket(s)", só o `tws-backups`;
   - TTL: sem vencimento, ou anote quando vence.
4. Na tela seguinte, copie **Access Key ID**, **Secret Access Key** e o endpoint **S3 API** (`https://<id-da-conta>.r2.cloudflarestorage.com`). A chave secreta só aparece uma vez.
5. No painel, em **Configurações → Backups → Armazenamento externo**, mantenha Cloudflare R2 marcado, cole os dados (região `auto`) e clique em **Testar e salvar**. Tem que aparecer "Conexão testada e salva" e o selo "Testado em…".
6. No cartão **Criptografia**:
   - crie a senha (ou **Sugerir uma frase forte**);
   - clique em **Baixar kit de recuperação** e guarde o arquivo fora da VPS;
   - marque **Guardei a senha em lugar seguro** e clique em **Ativar a criptografia**.
7. Clique em **Fazer backup agora** no Painel. O que conferir:
   - em "Últimos backups": "na VPS · cópia externa conferida";
   - no Cloudflare: R2 → `tws-backups` → pasta `TWS Panel Backups/_painel/` com o arquivo `.7z`, e `_verificacao/`;
   - baixe o `.7z` e abra no 7-Zip ou no Keka: ele pede a senha, e sem ela nem a lista de arquivos aparece;
   - **Testar minha senha** com a senha do kit tem que dar "Senha certa";
   - o roteiro de primeiros passos marca o passo 6 como feito.
8. Em cada projeto, abra a aba **Backups**:
   - confira os itens marcados e o aviso de arquivos fora de volume, se aparecer;
   - clique em **Fazer backup agora** e confira que o arquivo aparece em `TWS Panel Backups/<nome-do-projeto>/`.

### Restaurar o painel sem entrar nele (SSH)

1. Baixe o `.7z` de `TWS Panel Backups/_painel/` e copie para a VPS. Por exemplo: `scp 2026-10-14_03-00.7z root@<vps>:/root/`.
2. Na VPS:
   ```bash
   cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/2026-10-14_03-00.7z
   ```
   Ele pede a senha do backup sem mostrá-la. A cópia da VPS não tem senha, e nesse caso ele não pergunta.
3. O que conferir: a última linha diz "pronto. Entre no painel com o usuário e a senha do backup." Entre com o usuário e a senha do painel antigo. O estado de antes fica em `/var/lib/docker/volumes/paas_data/_data/backups/_painel/antes-da-restauracao/`.

## Passo a passo completo: "VPS nova" (a antiga foi perdida)

1. Crie a VPS nova (Ubuntu) e instale o painel como numa instalação nova (`scripts/install.sh`). Conclua o assistente, com usuário e senha quaisquer, porque eles vão ser trocados pelos do backup.
2. Abra **Configurações → Backups → Restaurar de outro servidor → Começar**.
3. **Passo 1**: no cartão **Armazenamento externo**, informe o **mesmo** endpoint, bucket, Access Key ID e Secret Access Key, que estão no kit de recuperação, e clique em **Testar e salvar**.
4. **Passo 2**: digite a senha dos backups (do kit) e clique em **Conferir e usar**. O painel abre o arquivo de verificação que a VPS antiga deixou. Se a senha estiver errada, ele diz e não salva.
5. **Passo 3**: clique em **Ver o que existe no armazenamento**.
6. **Painel primeiro**: clique em **Restaurar o painel**, escolha a data e digite `painel`.
   - O painel reinicia sozinho. Recarregue a página e entre com o **usuário e a senha do painel antigo**.
   - Voltam os projetos cadastrados, as configurações, o armazenamento e a senha dos backups.
7. Volte a **Configurações → Backups → Restaurar de outro servidor → Ver o que existe…**. Agora cada projeto aparece ligado ao cadastro.
8. **Projetos**: em cada um, clique em **Restaurar**.
   - "Publicar do GitHub antes de restaurar" já vem marcado.
   - Escolha a data e digite o nome do projeto.
   - O painel publica o código do GitHub, espera o deploy e põe os bancos e as pastas de volta.
   - Projetos de repositório privado precisam que a credencial do repositório já esteja no painel. Ela volta com o painel.
9. **E-mail por último**:
   - abra a página **E-mail** e clique em **Iniciar**, para o servidor de e-mail existir;
   - depois, em Backups, clique em **Restaurar o e-mail** e digite `e-mail`.
   - Voltam as caixas, as mensagens, as contas, as regras e as chaves DKIM. Se ele ainda não existir, a restauração avisa para iniciá-lo.
10. **DNS**: aponte os registros A dos projetos e do painel, o MX e o PTR (no provedor da VPS) para o IP novo. O DKIM não muda, porque a chave voltou com o e-mail.
11. O que conferir:
    - os sites abrem e os dados estão lá;
    - uma caixa recebe e envia;
    - em Configurações → Backups, **Fazer backup agora** no Painel termina com "cópia externa conferida".

## Objeções e diferenças em relação ao pedido

- **Código dos projetos que não vêm do GitHub entra no backup** (decisão 8). O pedido dizia para não fazer backup do código, mas nesses projetos não existe outra cópia.
- **Fuso**: o pedido era montar `/etc/localtime`. Montado no lugar do arquivo do container, não funciona com o Node, por isso a montagem foi feita em `/host/etc/localtime` e lida pelo painel (decisão 7).
- **E-mail com parada em vez de export nativo** (decisão 4).
- **Teste real com versitygw em vez de MinIO**: a imagem do MinIO não está disponível.
- **Senha do MongoDB**: fora do `ps` nas ferramentas 100.3+. Nas imagens `mongo` até 4.2 ela ainda vai por argumento (decisão 13).
- **Conferência visual** feita com Chromium e `playwright-core` instalados no rascunho da sessão. O Playwright do MCP gravava fora do worktree (`/home/kelvin/projects/paas/.playwright-mcp/`). Antes de trocar de ferramenta, ele criou ali um `.yml` de página e um `.log` de console desta sessão. Eles não foram apagados, porque ficam fora do worktree.
