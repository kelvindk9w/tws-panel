# Relatório — fuso horário pelo painel e conferência de backups

Branch `feat/fuso-conferir-backup` (a partir de `origin/dev`), worktree isolado.
Sem push, sem PR. Documentação técnica em `fuso/` e `backups/conferir.json`.

## 1. Fuso horário

### Como ficou

- **Configurações → Fuso horário** (`/settings/timezone`):
  - mostra o fuso da VPS e a hora de agora lá;
  - diz de onde veio o fuso (lido da VPS agora, último lido, `/etc/localtime` montado, `TZ` do `.env` ou nada);
  - seletor com busca: Brasil primeiro, com o estado ao lado e o deslocamento (UTC−3). A busca ignora acentos e `_` ("sao paulo" acha São Paulo);
  - **Aplicar na VPS** troca o fuso da VPS inteira pelo host bridge, sem SSH e sem recriar o container do painel;
  - o painel passa a usar o fuso novo na hora, e a agenda dos backups recalcula;
  - **Aplicar também nestes projetos**: lista com caixas, **Marcar todos** e **Nenhum**. Os marcados passam a "Igual ao da VPS" e reiniciam com o fuso novo. Cada um aparece com "reiniciando — acompanhe em Deploys" ou com o motivo de não ter reiniciado;
  - avisa quais projetos seguem a VPS mas só pegam o fuso novo depois de reiniciar;
  - sem host bridge (`PAAS_TARGET` diferente de `host`), mostra o motivo e o comando de SSH, e o botão fica desligado.
- **Campo Fuso horário do projeto** (aba Configurações do projeto). Tem três escolhas:
  - "Padrão da imagem (geralmente UTC)", que é o padrão;
  - "Igual ao da VPS", que acompanha as trocas da VPS;
  - "Um fuso específico".

  O cartão também:
  - lista os serviços que já definem TZ, com o valor e onde estão (compose, Variáveis, env_file);
  - avisa "A escolha vale depois de reiniciar os containers" e oferece **Reiniciar com o fuso novo**. O reinício não baixa código e aparece em Deploys como "Reinício com a configuração nova";
  - aponta cada serviço sem `/usr/share/zoneinfo` com "este serviço ignora o fuso; instale tzdata na imagem". A conferência é feita com `docker exec` ao abrir a tela.
- **Assistente de instalação**: o passo do diagnóstico ganhou o cartão "Fuso horário", com o fuso detectado e **Trocar o fuso** (mesmo endpoint). Ele não trava o assistente: se a leitura ou a troca falhar, só explica, e o "Continuar" segue funcionando.
- **Backups**: Configurações → Backups e a aba Backups do projeto mostram o fuso usado, com o link "Trocar em Configurações → Fuso horário". O roteiro não ganhou passo novo.

### Decisões

1. **A leitura do fuso vem do host bridge e fica guardada em `data/timezone.json`.** O painel não depende mais só da montagem `/etc/localtime:/host/etc/localtime:ro`. A montagem de um link simbólico fica presa no arquivo antigo depois de `timedatectl set-timezone`: foi o que exigiu `up -d --force-recreate`. Agora, na subida, a ordem é:
   1. TZ do `.env`;
   2. `data/timezone.json`;
   3. a montagem;
   4. UTC.

   Com `PAAS_TARGET=host`, o painel relê a VPS logo depois de subir e a cada 5 minutos com a tela aberta. Instalações existentes continuam funcionando, porque a montagem segue lá como reserva.
2. **Comando novo na allowlist do host bridge.** São dois:
   - leitura: `timedatectl show -p Timezone --value`, com `readlink -f /etc/localtime` como alternativa;
   - troca: `timedatectl set-timezone '<fuso>'`. Se não houver systemd, o painel faz `ln -sf` do zoneinfo e atualiza `/etc/timezone` quando o arquivo existe.

   O comando de troca só é aceito se for, byte a byte, o montado para um fuso da lista fechada. Cada execução é auditada (`timezone.host-exec`), e o resultado também (`timezone.applied` ou `timezone.apply_failed`). Depois de trocar, o painel relê o fuso para conferir: se a VPS não mudou, responde 502 e nada muda no painel.
3. **Lista fechada de fusos (418 nomes do `zone.tab` mais UTC e Etc/UTC).** O `Intl.supportedValuesOf` traz nomes antigos (Asia/Calcutta, Europe/Kiev), que o Ubuntu 24.04 só tem com `tzdata-legacy`.
4. **Precedência do TZ no projeto**, da mais forte para a mais fraca:
   1. `environment` do compose;
   2. TZ nas Variáveis, quando o serviço usa `env_file: .env`;
   3. outros `env_file`;
   4. a escolha do painel;
   5. `ENV TZ` da imagem.

   O painel nunca sobrescreve um TZ que o projeto define, e mostra quem define. O `ENV TZ` da imagem perde para a escolha, que é explícita. Quem quer o fuso da imagem escolhe "Padrão da imagem".
5. **Não montar `/etc/localtime` nos projetos.** A montagem teria o mesmo problema de ficar presa que o painel teve. Também contrariaria o "Padrão da imagem" e trocaria arquivos dentro da imagem do cliente. A variável TZ é entendida por glibc, musl (com tzdata), Node, Python, Java e PHP.
6. **Reiniciar = recriar sem build.** Um deploy do GitHub puxaria código novo junto, que não é o que a pessoa pediu ao trocar o fuso. Compose: `up -d --no-build` com o override novo. Dockerfile: recria da imagem existente. Site estático não tem fuso.
7. **Projetos marcados em "Aplicar também" passam para "Igual ao da VPS".** Assim acompanham as próximas trocas também.
8. **Node.js em alpine sem tzdata** acerta o fuso pelo ICU embutido, então o aviso de tzdata pode aparecer para um serviço Node que funciona. A tela diz isso numa linha.

## 2. Conferir backups

### Como ficou

- Em **Últimos backups** (Configurações → Backups) e no **Histórico** da aba Backups do projeto, cada backup mostra:
  - "Cópia da VPS: Íntegro — conferido em …", "Falhou: <motivo>", "apagada pela retenção" ou "ainda não conferida";
  - o mesmo para a cópia externa (a conferência automática depois do envio já conta);
  - o botão **Conferir**;
  - quando a senha guardada não abre a cópia externa, o campo "Senha da época do backup" com **Conferir com esta senha**. A senha só passa pela memória do pedido: não é guardada nem auditada.
- **Selo da cópia externa** (pedido extra) ao lado do "Concluído":
  - verde: "Externa conferida";
  - amarelo: "Enviando", "Conferindo" ou "Externa pede a senha da época";
  - vermelho: "Externa falhou";
  - cinza: "Só na VPS" ou "Externa apagada".

  O resultado do último Conferir manda no selo.
- **Conferir todos**: no cartão de cada item (Painel, E-mail, aba do projeto) e **Conferir todos os backups** em Últimos backups. A conferência entra na fila (um por vez) com "Conferindo… N de M". No fim fica o resumo, por exemplo "3 íntegras · 1 com problema · 1 pede a senha da época", com cada cópia com problema e o motivo.
- Cópia da VPS: confere o tamanho e o SHA-256 gravados no backup e roda `7zz t`.
- Cópia externa: baixa (conferindo o espaço em disco), compara o tamanho listado e o gravado e o hash, e roda `7zz t` com a senha guardada. Se não abrir, tenta a senha digitada; sem ela, pede a senha da época. Uma cópia que saiu cifrada e agora abre sem senha conta como falha.
- Quando alguma cópia falha:
  - o registro fica "Falhou";
  - sai um aviso pelas notificações, do tipo `backup_failed` (o mesmo de "backup falhou", para quem já ligou esse aviso), com a chave `backup-verify-failed:<item>`;
  - a auditoria registra `backups.verify` e `backups.verify_result`.
- Limite de taxa: 20 por minuto para Conferir um backup ou todos de um item; 5 por minuto para Conferir todos os backups.

### Decisões

- **Hash SHA-256 e tamanho gravados em cada backup novo**, nas duas cópias. Backups de antes desta versão não têm hash: a conferência usa o tamanho listado e o `7zz t`.
- **O tipo de notificação foi reaproveitado** (`backup_failed`), sem tipo novo. Assim não precisa de uma chave nova em Configurações → Notificações, e quem quer saber de backup com problema já ligou esse aviso.
- **O resultado de cada cópia fica no backup**, em `config.checks` do `data/backups.json`. A retenção esquece o hash das cópias que apagou.

## 3. O que foi testado de verdade

Ambiente: WSL com Docker 29, Node 22, `7zz` 25.01 baixado no scratchpad e S3 local com versitygw. O painel subiu de verdade (`tsx src/index.ts`), com um data dir isolado e sessão de admin.

- **TZ injetado em containers reais.** O projeto compose tinha nginx:alpine, um debian com `TZ: Europe/Lisbon` no compose, um alpine:3 sem tzdata e um debian sem TZ. Com o fuso "America/Manaus":
  - o log do deploy disse "TZ=America/Manaus nos serviços web, cron, app" e "worker já define TZ=Europe/Lisbon (no compose); mantido";
  - `docker inspect` mostrou o TZ certo em cada container;
  - `date` deu `-04` no debian e no nginx, `WEST` no worker e `UTC` no alpine sem tzdata;
  - a tela marcou só o alpine com o aviso de tzdata.
- **"Igual ao da VPS" e reinício.** Salvar a escolha pediu reinício. "Reiniciar" recriou o container (id novo) com o TZ novo, e depois disso o reinício deixou de ser pedido. "Padrão da imagem" com reinício tirou o TZ, e o worker ficou com o dele. Antes do primeiro deploy, o reinício foi recusado com o motivo.
- **Sem host bridge.** Trocar o fuso deu 409 com o comando de SSH. Um nome fora da lista deu 400.
- **Comando de troca de fuso.** O comando exato do host bridge rodou num `debian:bookworm-slim`: saiu com 0, o `/etc/localtime` passou a ser o de São Paulo, o `date` deu `-03` e o `/etc/timezone` foi atualizado. A releitura devolveu `America/Sao_Paulo`. Num `ubuntu:24.04` sem tzdata, o comando sai com 1 e o painel responderia 502 sem mudar nada.
- **Backups com S3 local e 7zz de verdade.**
  - O backup do projeto foi enviado e conferido.
  - Conferir: as duas cópias íntegras.
  - Depois de trocar a senha, a cópia antiga pediu a senha da época, e com ela digitada ficou íntegra. Nenhuma senha apareceu na auditoria.
  - Com um byte trocado nas duas cópias (VPS e S3), o resultado foi "Falhou": "O conteúdo mudou desde o backup (hash diferente)" e "O arquivo baixado não bate com o enviado (hash diferente)". O `backups.verify_result` ficou na auditoria.
  - Conferir todos (geral) resumiu 4 cópias.
- **Telas no painel de verdade** (playwright-core e Chromium do scratchpad, fora do repositório), em 1280 px e 390 px: Configurações → Fuso horário, fuso do projeto com a busca, Deploys com o reinício, Últimos backups com selos, conferências e o campo de senha, e a aba Backups do projeto. O console do navegador não mostrou nenhum erro.

### O que não foi testado de verdade

- A troca do fuso numa VPS real com systemd, pelo `nsenter` do host bridge. O comando foi testado num container, e o caminho do host bridge só com dublês.
- Notificação de conferência com falha chegando por Telegram ou e-mail: no teste não havia canal configurado. O envio está coberto por teste com dublê.
- Cloudflare R2 real. O versitygw fala o mesmo S3.
- O assistente de instalação no navegador. Ele tem testes de componente; o print exigiria refazer o setup.

### Observações

- As rotas de backups exigem sessão. Chamá-las só com o setup token (antes de existir conta) dá 500 em vez de 401. O problema já existia antes desta branch e não foi mexido.
- Na máquina de teste, o Docker estava sem faixas de rede livres. O compose de teste usou uma sub-rede fixa, e isso não afeta o painel.
- Em desenvolvimento, sem host bridge e sem `TZ`, o painel mostra "UTC", mas o processo usa o fuso da máquina. No container de produção isso não acontece, porque o sistema do container é UTC e o fuso vem do host.

## 4. Passo a passo na VPS

### Atualizar

```
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

Não precisa de `--force-recreate`. Daqui em diante, o fuso é lido pelo host bridge.

### Conferir o fuso

1. Abra **Configurações → Fuso horário**. Deve aparecer o fuso da VPS, por exemplo "America/Sao_Paulo (UTC−3)", com a hora certa, e a origem não deve dizer "pode estar desatualizado".
2. Se aparecer o aviso de `TZ` no `.env`, apague a linha `TZ=` de `/opt/tws-panel/.env` e rode `cd /opt/tws-panel && sudo docker compose up -d`. Assim o painel passa a seguir a VPS.
3. Teste a troca escolhendo outro fuso, por exemplo America/Manaus, e clicando em **Aplicar na VPS**. Confira pelo SSH com `timedatectl`, que deve mostrar o fuso novo. Em **Auditoria** devem aparecer `timezone.host-exec` e `timezone.applied`. Depois volte para America/Sao_Paulo.
4. Em **Configurações → Backups**, a linha "Os horários seguem o fuso da VPS" deve mostrar o fuso, e "Próximo" deve ser 03:00 nesse fuso.

### Conferir o fuso de um projeto

1. No projeto, abra **Configurações → Fuso horário**, escolha "Igual ao da VPS", clique em **Salvar** e depois em **Reiniciar com o fuso novo**.
2. Em **Deploys** aparece "Reinício com a configuração nova", com sucesso.
3. Pelo SSH: `sudo docker exec <container> date` mostra a hora local, e `sudo docker inspect -f '{{.Config.Env}}' <container>` mostra `TZ=America/Sao_Paulo`.
4. Se aparecer "este serviço ignora o fuso; instale tzdata na imagem", adicione `tzdata` à imagem desse serviço (num Dockerfile alpine: `RUN apk add --no-cache tzdata`) ou ignore o aviso, se o serviço for Node.

### Conferir os backups

1. Em **Configurações → Backups → Últimos backups**, cada backup tem dois selos ("Concluído" e o da cópia externa), as linhas "Cópia da VPS" e "Cópia externa" e o botão **Conferir**.
2. Clique em **Conferir** num backup. Aparece "Conferindo… 1 de 2" e depois "Íntegro — conferido em <data>" nas duas cópias.
3. Clique em **Conferir todos os backups** e espere o resumo, por exemplo "N íntegras".
4. Se algum backup for de antes de uma troca de senha, ele mostra o campo da senha da época. Digite a senha antiga e clique em **Conferir com esta senha**.
5. Em **Auditoria** aparecem `backups.verify` e `backups.verify_result`.
