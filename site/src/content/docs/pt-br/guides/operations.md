---
title: "Operação do painel na VPS"
description: "O dia a dia: atualizar o painel, scripts de emergência, onde ficam os arquivos dos projetos e como trocar o usuário do terminal ou a porta do painel."
sidebar:
  label: "Operação"
---

O dia a dia depois da instalação: atualizar, comandos úteis, onde ficam os arquivos e como
trocar o usuário do terminal ou a porta do painel. Todos os comandos rodam **na VPS**, conectado
por SSH com o seu usuário, dentro de `/opt/tws-panel`.

## Atualizar o painel

Uma linha só, na VPS:

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

O `git log --oneline -1` mostra o commit que ficou no ar, para você conferir. Seus projetos,
domínios, e-mail e a conta de administrador continuam como estavam. O que mudou em cada versão
está no [CHANGELOG](https://github.com/kelvindk9w/tws-panel/blob/main/CHANGELOG.md).

> [!NOTE]
> **Por que essa linha recria o container do painel.** Algumas versões acrescentam uma montagem ao container do painel (o
> monitoramento de recursos precisa do `/proc` e do `/sys/fs/cgroup` do servidor, **somente leitura**). Uma montagem só passa a
> existir quando o container é **recriado**, e o `docker compose up -d --build` faz isso sozinho quando o arquivo do compose mudou.
> Um simples `docker restart tws-panel` **não** pega montagens novas: use a linha acima. Se o Dashboard disser "Monitoramento em
> modo reduzido", essa é a causa. Veja [Monitoramento de recursos](features.md#monitoramento-de-recursos).

## Scripts de emergência

| Situação | Comando (em `/opt/tws-panel`) | Guia |
|---|---|---|
| Perdeu o setup token | `sudo ./scripts/show-token.sh` | [Instalação](../getting-started/installation.md#passo-8) |
| Quer refazer o wizard | `sudo ./scripts/reset-setup.sh` (`--full` apaga também a conta admin) | [Recuperar o acesso](recover-access.md) |
| Perdeu o celular e os códigos da verificação em duas etapas | `sudo ./scripts/reset-2fa.sh` | [Recuperar o acesso](recover-access.md) |
| Desativou o acesso pelo IP e o domínio do painel parou de abrir | `sudo ./scripts/reativar-acesso-ip.sh` | [Funcionalidades](features.md#dominio-do-painel) |
| O painel não abre e você tem um backup `.7z` dele | `sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z` | [Funcionalidades](features.md#backups) |
| Quer remover o painel | `./scripts/uninstall.sh --dry-run` e depois `./scripts/uninstall.sh` | [Instalação](../getting-started/installation.md#remover-o-painel) |

> [!WARNING]
> **O `restaurar-painel.sh` traz o backup inteiro, sem ajustes.** Restaurar o painel pela tela
> (**Configurações → Backups → Restaurar de outro servidor**) mantém as chaves do armazenamento
> desta VPS, mantém o acesso pelo IP ativado enquanto o domínio do painel não aponta para cá e põe
> em pausa, por até 7 dias, a agenda dos projetos e do e-mail. O script não faz nada disso: as
> **chaves antigas do armazenamento** voltam (informe as novas de novo em **Configurações → Backups →
> Armazenamento externo → Editar**), o acesso pelo IP volta **desativado** se estava (use o
> `reativar-acesso-ip.sh` se o domínio do painel não abrir) e a agenda antiga volta sem pausa.
> Detalhes em [Restaurar numa VPS nova](restore-new-server.md) e em
> [Funcionalidades](features.md#backups).


## Onde ficam os arquivos dos seus projetos

Cada projeto que você implanta tem uma pasta própria no servidor, com o código clonado do Git (em `src/`)
e os arquivos que o painel gera ao redor dele (como `repo.git` e `paas.env`). Por padrão essas pastas ficam em
**`/opt/tws-projects`** — ao lado de `/opt/tws-panel`, e fora de qualquer `/home`, para não
sumirem se você um dia apagar um usuário do Linux.

Elas ficam num diretório de verdade da VPS, e não escondidas dentro do container, por dois
motivos práticos:

- **Você consegue olhar.** Conectado por SSH, `ls /opt/tws-projects` já mostra tudo; dá para
  ler um log, copiar um arquivo ou fazer backup com as ferramentas de sempre.
- **Projetos que gravam arquivos funcionam.** Se o `docker-compose.yml` do seu projeto tem uma
  linha como `./dados:/app/dados` (guardar uploads, um banco SQLite, o que for), quem procura
  essa pasta `dados` é o Docker **da VPS**, não o painel. Se ela existisse só dentro do
  container do painel, o Docker criaria uma pasta vazia e o seu projeto subiria sem os dados.
  Por isso o caminho é exatamente o mesmo dentro e fora.

**Quer usar outro lugar** (um disco maior montado em `/mnt/dados`, por exemplo)? Escolha na
hora de instalar:

```bash
./scripts/install.sh --projects-dir=/mnt/dados/projetos
```

> [!IMPORTANT]
> Essa escolha é feita **na instalação**, não numa tela do painel. Trocar a pasta significa
> trocar uma montagem do container, e um container só pega uma montagem nova quando é
> recriado. Se precisar mudar depois, edite a linha `PAAS_PROJECTS_DIR=` do arquivo `.env` em
> `/opt/tws-panel`, mova os arquivos antigos para o novo lugar (`sudo mv`), ajuste o dono
> (`sudo chown -R 10001:10001 /novo/caminho`) e rode `sudo docker compose up -d` — ele recria o
> painel com a nova pasta. Só reiniciar (`restart`) **não** basta.

> [!NOTE]
> Se você já tinha o painel instalado antes desta mudança, nada se move sozinho: sem a linha
> `PAAS_PROJECTS_DIR=` no `.env`, o painel continua usando o lugar antigo e os projetos que
> você já criou seguem onde estavam.

<a id="trocar-terminal"></a>

## Trocar o usuário do terminal do painel

O usuário com que o terminal abre e o modo (`senha` ou `segundo-plano`) ficam gravados no arquivo
`.env` de `/opt/tws-panel`. Para mudar, rode o instalador de novo pedindo para ele perguntar outra
vez:

```bash
cd /opt/tws-panel
./scripts/install.sh --reconfigure-terminal
```

Ele refaz as mesmas perguntas, valida a resposta e recria o painel com a escolha nova. Seus
projetos, domínios, e-mail e a conta de administrador não são tocados — é a mesma reinstalação
segura de sempre. Se preferir não responder nada, informe direto:

```bash
./scripts/install.sh --terminal-user=OUTRO_USUARIO --root-mode=segundo-plano
```

> [!NOTE]
> Instalou o painel antes de essa pergunta existir? Nada muda sozinho: sem as linhas
> `PAAS_TERMINAL_USER=` e `PAAS_ROOT_MODE=` no `.env`, o terminal continua abrindo como root, como
> antes. Rodar o instalador de novo de forma interativa faz a pergunta — e, se quiser manter tudo
> como está, basta responder `root`.

<a id="trocar-porta"></a>

## Trocar a porta do painel na VPS

**Só faz diferença no acesso por túnel.** No acesso por HTTPS (o padrão) essa porta é interna —
o painel escuta só dentro da VPS e quem atende de fora é o proxy, nas portas 80/443 — e o instalador
a escolhe sozinho.

No acesso por túnel, a porta é a que você escolheu na instalação (padrão `9000`) e fica gravada na
linha `PAAS_PORT=` do `.env` de `/opt/tws-panel`. Para trocar, rode o instalador de novo informando
a nova:

```bash
cd /opt/tws-panel
./scripts/install.sh --port=9500
```

Ele confere se a porta nova está livre, recusa as que quebrariam o painel (22, 80, 443 e as do
e-mail), recria o container e imprime o comando de túnel já com o número certo. Seus projetos,
domínios, e-mail e a conta de administrador não são tocados.

> [!NOTE]
> Só a porta **de fora** muda. Dentro do container o painel continua atendendo na 9000 — é o
> `docker-compose.yml` que faz a ligação (`"127.0.0.1:${PAAS_PORT:-9000}:9000"` — só dentro da
> VPS). Por isso não adianta
> editar o `.env` e dar `restart`: um container só pega uma publicação de porta nova quando é
> recriado (`sudo docker compose up -d`).

> [!TIP]
> Se o problema é a porta ocupada **no seu computador** na hora de abrir o túnel, não mexa aqui:
> troque só o número da esquerda do `ssh -L`. Veja [as duas portas do túnel](../getting-started/installation.md#duas-portas).

> [!IMPORTANT]
> **Atualizando uma instalação anterior ao acesso por HTTPS?** Desde essa versão o painel escuta
> **só dentro da VPS**: o endereço `http://SEU-IP:PORTA` deixa de abrir (ele deixava a porta aberta
> na internet mesmo com o firewall). Depois do `git pull`, rode o instalador em vez do
> `docker compose up`:
>
> ```bash
> cd /opt/tws-panel && sudo git pull && ./scripts/install.sh
> ```
>
> Ele mantém suas escolhas (usuário do terminal, projetos, contas), configura o endereço
> `https://…sslip.io` e mostra o link no final. Prefere continuar só com túnel? Use
> `./scripts/install.sh --acesso=tunel`.

> [!NOTE]
> **Atualizar durante um deploy.** Recriar o painel interrompe o deploy que estiver rodando. O
> `./scripts/install.sh`, ao atualizar, confere isso antes de reconstruir: se há um deploy em andamento,
> avisa e espera ele terminar (até 15 minutos, com uma mensagem de andamento a cada 30 segundos). Use
> `./scripts/install.sh --sem-esperar-deploy` para não esperar. Se um deploy for interrompido mesmo assim, quando o painel
> volta ele religa a versão anterior (projetos Next.js com servidor) ou marca o deploy como
> "interrompido pela atualização do painel" no histórico e avisa pelas notificações: nos demais tipos o site
> pode ficar fora do ar até você fazer o deploy de novo.
>
> O proxy também não é reiniciado por causa de um ajuste que falhou: o Caddy valida a configuração nova antes
> de recarregar e, se ela for recusada, segue com a anterior e o motivo aparece em **Logs do servidor**.

## Comandos úteis (produção)

```bash
sudo docker compose ps            # status do painel
sudo docker compose logs -f panel # logs em tempo real
sudo docker compose up -d --build # atualizar para uma nova versão (git pull antes; prefira o ./scripts/install.sh, que espera um deploy em andamento)

sudo ./scripts/show-token.sh      # reexibe a URL + setup token (se você perdeu o token)
sudo ./scripts/reset-setup.sh     # recomeça o wizard do zero (--full apaga também usuários/sessões)
./scripts/install.sh --reconfigure-terminal   # troca o usuário/modo do terminal do painel
./scripts/install.sh --port=9500              # troca a porta do painel na VPS
./scripts/uninstall.sh --dry-run              # mostra o que a remoção do painel apagaria
```

> [!NOTE]
> Os comandos de Docker e os scripts `show-token.sh` e `reset-setup.sh` levam `sudo` porque o
> painel não coloca ninguém no grupo docker — estar nele é ter root sem senha
> ([entenda](../getting-started/installation.md#grupo-docker)). Sem o `sudo`, o erro é `permission denied ... docker.sock`.
