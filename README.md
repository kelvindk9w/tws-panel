# TWS Panel

> **Transforme qualquer VPS Ubuntu em sua própria plataforma de hospedagem — segura, com e-mail profissional e zero mensalidade de painel.**

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](#roadmap)

---

## Por que este projeto existe?

A TWS pagava **R$50/mês** em um plano de hospedagem praticamente só para ter e-mail
profissional para **1 cliente**. Testamos painéis pesados que assumiam o controle de toda a
máquina (e quebravam stacks que já funcionavam) e hospedagens que nos deixavam na mão. Então
decidimos construir o painel que queríamos ter encontrado: **leve, não-invasivo e seguro desde
o primeiro boot** — e liberar para a comunidade sob licença MIT.

## O que é

Um painel open-source que transforma uma VPS Ubuntu 22.04/24.04 crua em uma plataforma de
hospedagem pessoal. Você roda **um comando** e um assistente web passo a passo protege a máquina,
configura o painel e deixa tudo pronto para publicar projetos com Docker, domínios com SSL
automático e e-mail profissional com DKIM/SPF/DMARC.

**Princípios**

- **Não-invasivo** — trabalha *com* o Docker que já existe na máquina; nunca mexe em stacks que já funcionam.
- **Segurança primeiro** — nada sobe antes do hardening; baseline + monitoramento contínuo.
- **Minimalista** — a VPS fica com o mínimo de pacotes; painel leve (Fastify + arquivos JSON em disco, sem banco de dados algum).
- **Open source** — MIT, pensado para contribuição desde o dia 1.

## Funcionalidades

| Módulo | O que faz |
|---|---|
| **🖥️ Terminal web embutido** | **Visão dupla** nos 4 passos do wizard: em cima a UI formatada (cards/fases), embaixo um **terminal real ao vivo** do servidor (xterm.js + WebSocket + PTY), numa janela contida estilo IDE — **bloqueado até o setup token ser validado** e recolhido por padrão. As varreduras e as fases de hardening rodam DENTRO dele — você vê os comandos de verdade (`cat /etc/os-release`, checks do Lynis, scripts de fase), como no SSH. Prompts de senha/confirmação são digitados direto no terminal: o backend faz **relay puro** do PTY e **nunca lê, loga ou armazena** o que você digita (audita só conexão/desconexão). |
| **🛡️ Wizard de segurança** | Scan com **Lynis** + checks próprios (score antes/depois), hardening idempotente em fases (SSH, UFW, fail2ban, unattended-upgrades, auditd/AIDE…), backup de cada arquivo alterado e **rollback automático** agendado — cancelado só depois que você confirma que continua com acesso. Disponível também **depois da instalação**, em `/security/hardening`, para revisar ou reaplicar quando quiser. |
| **🚀 Deploy** | **3 modos de ingestão** (git com branch configurável, upload de diretório, ou adoção de um compose existente — sem reescrevê-lo), **detecção automática** de pipeline (estático Node, Dockerfile, compose), **Caddy central** com SSL automático e reload sem downtime, suporte a WebSocket/conexões longas, logs de deploy em tempo real. Nome, repositório, branch e domínio são **editáveis depois de criado**, e a tela mostra qual branch está de fato no ar quando a configuração diverge do último deploy. |
| **🌿 Múltiplos ambientes** | O mesmo repositório pode ser hospedado mais de uma vez em branches e domínios diferentes — produção em `main` e sandbox em outra branch, lado a lado na mesma VPS. Cada projeto tem clone, imagem, containers e rede próprios; só o domínio precisa ser único. |
| **📧 E-mail** | Servidor **Stalwart** (SMTP + IMAP + DKIM em um container), par **DKIM RSA 2048** gerado por domínio, **checklist DNS verificável** (A/AAAA/MX/SPF/DKIM/DMARC/PTR) com valores prontos para colar no provedor, texto pronto para abrir chamado de PTR, criação de caixas com **credenciais prontas para Outlook/Gmail/Thunderbird**, e injeção automática de variáveis SMTP nos seus projetos. |
| **🚧 Guardrails** | **6 regras** de segurança de deploy em 3 níveis (`block`, `warn`, `info`): porta de banco exposta no host, credenciais fracas, container privilegiado, serviço de dev em produção, secret comitado no código, tag `:latest`. Blocks exigem **override explícito e auditado**, com evidência e sugestão de correção. |
| **📊 Monitoramento** | **Baseline** pós-hardening (pacotes, portas, hashes de arquivos críticos) + scans recorrentes com **diff** (o que mudou vira alerta), verificação de **blacklist de e-mail** (Spamhaus ZEN, SpamCop, Barracuda, Spamhaus DBL), central de alertas e **log de auditoria** de todas as ações sensíveis. |

## Instalação — VPS limpa do zero

> [!NOTE]
> **Único pré-requisito:** uma VPS com Ubuntu 22.04 ou 24.04 LTS limpa. Docker, Node e todo o resto são instalados automaticamente — basta seguir os passos abaixo, na ordem.

**1. Contrate uma VPS** com Ubuntu 24.04 LTS (mínimo recomendado: 1 vCPU / 2 GB RAM / 25 GB de disco).

**2. Acesse como root via SSH** e confirme a versão do SO:

```bash
ssh root@SEU_IP
cat /etc/os-release   # esperado: PRETTY_NAME="Ubuntu 24.04.x LTS" (ou 22.04)
```

<details>
<summary>🔐 <strong>Primeira vez conectando via SSH? O que aparece e o que responder</strong></summary>

Na **primeira conexão** com qualquer servidor novo, o SSH mostra este aviso:

```text
The authenticity of host '203.0.113.10 (203.0.113.10)' can't be established.
ED25519 key fingerprint is SHA256:Xk9vN2mQpL7dR4wT8yB3cF6hJ1uA5sE0gH9zK2xW4vM.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

**O que responder:** digite `yes` e pressione Enter.

**O que é isso?** O *fingerprint* é a "digital" do servidor — é assim que o seu computador
reconhece a VPS nas próximas conexões. O aviso aparece **só na primeira vez**; depois o
fingerprint fica salvo e a conexão é direta.

**Erros comuns:**

- **"Digito a senha e nada aparece"** — é normal! O terminal **não mostra nenhum caractere**
  (nem `*`) enquanto você digita senhas. Digite com calma e pressione Enter.
- **`Permission denied (publickey,password)`** — senha errada ou o provedor da VPS exige
  chave SSH. Confira a senha no painel do provedor e tente de novo.
- **O aviso de fingerprint aparece de novo depois de reinstalar a VPS** — normal, a máquina
  mudou. Remova a entrada antiga com `ssh-keygen -R SEU_IP` e conecte novamente.

</details>

**3. Crie o seu usuário não-root** — é ele quem vai operar a VPS daqui em diante:

```bash
adduser kelvin           # troque "kelvin" pelo nome que quiser; você escolhe a senha na hora
usermod -aG sudo kelvin  # dá permissão de administrador (sudo)
```

Agora entre na conta que você acabou de criar. Há duas formas — a segunda é a recomendada,
porque com ela você **sai de vez da conta de root**, em vez de ficar com ela aberta por baixo:

```bash
# Opção A — atalho: troca de usuário sem sair da sessão atual
su - kelvin
```

```bash
# Opção B (recomendada) — encerra a sessão root e entra direto como o novo usuário
exit                     # sai do root e fecha a conexão SSH
ssh kelvin@SEU_IP        # conecte de novo; "kelvin" é o usuário que você acabou de criar
                         # e a senha é a que você definiu no adduser
```

A partir daqui, **todos os passos são feitos como esse usuário** — o que precisar de permissão
de administrador vai pedir `sudo` e a sua senha.

<details>
<summary>🤔 <strong>Por que a opção B é a recomendada?</strong></summary>

Com `su - kelvin` você continua **dentro da sessão do root** — apenas com outra identidade por
cima. Um `exit` te devolve ao root em vez de encerrar o acesso, e é fácil esquecer que aquele
terminal ainda tem uma sessão de root aberta embaixo.

Entrando por SSH direto como o seu usuário, a sessão é dele do começo ao fim: `exit` encerra de
verdade, e tudo que exigir privilégio vai passar por `sudo` — que pede senha e fica registrado
no log do sistema. É a diferença entre "estou de root com outro chapéu" e "estou como usuário
comum e peço permissão quando preciso".

Isso também conversa com o passo anterior: se você configurou o keepalive e vai deixar a
sessão aberta por um tempo, é melhor que ela seja a do seu usuário, não a do root.

**A opção A não está errada** — funciona e é mais rápida se você só quer seguir o passo a passo
agora. Só saiba que a sessão root continua ali atrás.

</details>

<details>
<summary>👤 <strong>Travou no <code>adduser</code>? O que aparece e o que preencher</strong></summary>

Ao rodar `adduser kelvin`, o sistema faz uma série de perguntas. É assim que aparece:

```text
Adding user `kelvin' ...
Adding new group `kelvin' (1000) ...
Adding new user `kelvin' (1000) with group `kelvin' ...
Creating home directory `/home/kelvin' ...
Copying files from `/etc/skel' ...
New password:
Retype new password:
passwd: password updated successfully
Changing the user information for kelvin
Enter the new value, or press ENTER for the default
        Full Name []:
        Room Number []:
        Work Phone []:
        Home Phone []:
        Other []:
Is the information correct? [Y/n]
```

**O que preencher, passo a passo:**

1. **`New password:`** — crie uma senha forte **que você vai lembrar** (é a senha do seu
   usuário, usada no SSH e no `sudo`). Atenção: **nada aparece enquanto você digita** —
   nem `*`. É normal, a senha está sendo registrada. Digite e pressione Enter.
2. **`Retype new password:`** — repita a mesma senha.
3. **`Full Name`, `Room Number`, `Work Phone`, `Home Phone`, `Other`** — dados opcionais.
   Pode deixar tudo em branco: basta pressionar **Enter** em cada um.
4. **`Is the information correct? [Y/n]`** — digite `Y` (ou só Enter) para confirmar.

**Erros comuns:**

- **`Sorry, passwords do not match`** — as duas senhas digitadas foram diferentes. O sistema
  repete o pedido; digite as duas iguais, com calma.
- **`BAD PASSWORD: ...`** — aviso de senha fraca. O sistema aceita, mas prefira uma senha
  longa (frase com palavras + números, ex.: `cavalo-bateria-42-janela`).
- **"Acho que digitei errado porque não vi nada"** — sem problemas: se errou, o `adduser`
  reclama (`Sorry, try again.`) e pede de novo.

</details>

> [!IMPORTANT]
> **Por que antes de tudo?** Operar como root é um anti-padrão de segurança. Criando o usuário agora,
> o wizard só precisa **validar** que ele existe (Fase 01 de segurança) em vez de criá-lo — e o
> acesso root será travado no final do processo. **Anote o nome escolhido**: você vai digitá-lo de
> novo no passo de Segurança do wizard.

**Ainda no passo 3 — a conexão está caindo sozinha quando você para de digitar?**

Se você já percebeu a sessão fechando depois de alguns minutos parado, o culpado quase sempre
é o **provedor da VPS**, não o servidor: firewalls de rede costumam descartar conexões que
ficam um tempo sem tráfego. O seu computador pode resolver isso mandando um sinal de vida a
cada minuto. Rode **no seu computador**, não na VPS:

```bash
# no SEU computador (Linux/macOS). No Windows com PuTTY, o campo equivalente é
# "Seconds between keepalives" em Connection.
printf 'Host *\n    ServerAliveInterval 60\n    ServerAliveCountMax 3\n' >> ~/.ssh/config
```

Depois disso, reconecte. **Isso não enfraquece a segurança** — a sessão continua sendo
encerrada se a rede realmente cair; o que muda é que ela para de *parecer* abandonada enquanto
você está trabalhando.

> [!IMPORTANT]
> **Mais adiante, no wizard, isso muda.** Quando você aplicar o passo de segurança do painel,
> ele passa a encerrar sessões ociosas por conta própria, em cerca de **10 minutos**. É
> proposital: protege você de deixar um terminal aberto e esquecido — num notebook, num café,
> numa máquina compartilhada. Com o keepalive acima configurado, você não sente isso enquanto
> está trabalhando, só quando realmente abandona a sessão.
>
> **Recomendamos deixar assim.** Mas se o seu caso exigir sessões ociosas mais longas (um build
> demorado que você acompanha de longe, por exemplo), crie um arquivo **seu** com o nome exato
> abaixo. Copie e cole as três linhas de uma vez — sem editor de texto, sem margem para erro de
> digitação:
>
> ```bash
> printf 'ClientAliveInterval 600\nClientAliveCountMax 6\n' | sudo tee /etc/ssh/sshd_config.d/10-local-override.conf
> sudo sshd -t && sudo systemctl restart ssh
> sudo sshd -T | grep -i clientalive
> ```
>
> O tempo até a desconexão é `ClientAliveInterval` **×** `ClientAliveCountMax` — acima, 600 × 6 =
> **1 hora**. Para nunca desconectar por ociosidade, use `0` nos dois valores (não recomendamos).
>
> **O nome do arquivo não é decoração.** O painel grava a configuração dele em
> `99-paas-hardening.conf`, e o SSH lê os arquivos dessa pasta em ordem alfabética valendo **o
> primeiro valor que encontrar**. Um arquivo começando por `10-` é lido antes e por isso vence; um
> `99-alguma-coisa` seria lido depois do painel e simplesmente não teria efeito nenhum.
>
> As duas últimas linhas são a sua rede de proteção. O `sshd -t` confere o arquivo **antes** de
> reiniciar — sem ele, um erro de digitação pode impedir o SSH de subir e te deixar sem acesso à
> máquina. O `sshd -T` mostra o que o servidor de fato adotou, então você não fica no achismo:
> tem que aparecer `clientaliveinterval 600` e `clientalivecountmax 6`. Mantenha a janela atual
> aberta e teste a reconexão em **outra** antes de fechar a que funciona.
>
> **E quando terminar o que precisava**, apague o arquivo. O padrão do painel volta a valer
> sozinho, sem você precisar lembrar quais eram os valores originais:
>
> ```bash
> sudo rm /etc/ssh/sshd_config.d/10-local-override.conf
> sudo sshd -t && sudo systemctl restart ssh
> ```

**4. Gere sua chave SSH** — antes de ir para o wizard:

O passo de Segurança do wizard vai desligar o login por senha no SSH (fase 02 do hardening). A
partir daí, a chave é a sua porta de entrada — e o wizard **pede a chave pública já na primeira
fase**, com um rollback automático de 5 minutos correndo. Gerando agora, com o terminal já
aberto, você não para no meio do processo para trocar de janela.

> [!TIP]
> **A senha que você acabou de criar no `adduser` não vai embora.** O que muda é só a porta de
> entrada remota (SSH). Dentro da máquina, essa senha continua sendo a que o `sudo` pede.

Rode os comandos abaixo **no seu computador, não na VPS** — é lá que a chave precisa existir
para você se autenticar depois.

**Linux, macOS ou WSL:**

```bash
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

**Windows (PowerShell):**

```powershell
ssh-keygen -t ed25519
Get-Content ~\.ssh\id_ed25519.pub
```

O `ssh-keygen` faz duas perguntas:

1. **Onde salvar o arquivo** — pressione Enter para aceitar o local padrão.
2. **Passphrase** — recomendada; é uma senha extra só para usar a chave, e **nada aparece na
   tela** enquanto você digita. Se não quiser digitá-la toda vez, rode `ssh-add` depois para
   guardá-la na sessão atual.

> [!IMPORTANT]
> O comando gera **dois arquivos**, e eles não são intercambiáveis:
>
> - **`id_ed25519.pub`** — a chave **pública**. É a que você cola no wizard. Pode ser mostrada a
>   qualquer um, sem risco.
> - **`id_ed25519`** (sem extensão) — a chave **privada**. **Nunca sai do seu computador**, nunca
>   é colada em lugar nenhum. Quem tiver esse arquivo tem acesso à VPS.
>
> A linha inteira que o `cat`/`Get-Content` mostrou — começando em `ssh-ed25519` — é o que vai no
> campo de chave pública da fase 01 do wizard.

<details>
<summary>🔑 <strong>E se eu perder, apagar ou corromper a chave privada?</strong></summary>

**Prevenção (faça isso antes de seguir em frente):**

- Guarde uma cópia da chave privada em lugar seguro, como um gerenciador de senhas. Quem tiver
  essa cópia acessa a VPS — trate-a como uma senha.
- Alternativa mais robusta: tenha uma **segunda chave**, gerada num outro dispositivo (outro
  computador, ou o seu celular). O campo do wizard aceita **uma chave por vez**, então instale a
  segunda depois de concluir o wizard, enquanto a primeira ainda funciona.

  Pegue a chave **pública** do outro dispositivo (o conteúdo do `.pub` dele), conecte na VPS pelo
  computador que já tem acesso e acrescente a linha:

  ```bash
  echo "COLE_AQUI_A_SEGUNDA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
  ```

  Use `>>` e não `>` — um `>` sozinho **apaga** as chaves existentes e te tranca para fora na
  próxima conexão. Confira o resultado com `cat ~/.ssh/authorized_keys`: devem aparecer as duas
  linhas. Assim, perder um dispositivo não te deixa sem acesso.

**Se você já perdeu a chave** — ou a senha, ou o acesso ao painel — veja
[Perdi o acesso — e agora?](#perdi-o-acesso--e-agora), que cobre cada caso e o caminho de volta.

</details>

**5. Instale o git:**

```bash
sudo apt update && sudo apt install -y git
```

<details>
<summary>🔑 <strong>Primeiro <code>sudo</code>: o aviso gigante e a senha que não aparece</strong></summary>

Na **primeira vez** que você usa `sudo` com um usuário novo, aparece um aviso clássico:

```text
We trust you have received the usual lecture from the local System
Administrator. It usually boils down to these three things:

    #1) Respect the privacy of others.
    #2) Think before you type.
    #3) With great power comes great responsibility.

[sudo] password for kelvin:
```

**O que fazer:**

1. O aviso é só cerimônia de boas-vindas (uma tradição do Linux) — não exige resposta.
2. Em **`[sudo] password for kelvin:`**, digite **a senha do SEU usuário** (a que você criou
   no `adduser`), **não** a senha de root.
3. Lembre-se: **nada aparece na tela enquanto você digita** — nem `*`. Digite e Enter.

Esse aviso longo só aparece uma vez. Depois disso o `sudo` pede a senha direto — e, por
alguns minutos, nem isso (ele "lembra" que você se autenticou).

**Erros comuns:**

- **`Sorry, try again.`** — senha errada. Você tem 3 tentativas antes de o comando falhar.
- **`kelvin is not in the sudoers file`** — o usuário não tem permissão de administrador.
  Volte para a sessão de root e rode `usermod -aG sudo kelvin` (passo 3).

</details>

**6. Clone o repositório em `/opt` e dê a propriedade da pasta ao seu usuário:**

```bash
sudo git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
sudo chown -R $USER:$USER /opt/tws-panel
cd /opt/tws-panel && git checkout main
```

> [!TIP]
> O clone começa na branch `dev` (default do repositório, usada pelos contribuidores). Para
> **uso real**, sempre use a `main` — ela só recebe código validado e testado. Quer ajudar no
> desenvolvimento? Fique na `dev` (veja o [CONTRIBUTING.md](CONTRIBUTING.md)).

> [!IMPORTANT]
> **Confira que a `main` está em dia antes de instalar.** Já aconteceu de a `main` ficar 96
> commits atrás enquanto este README mandava instalar a partir dela. Rode:
>
> ```bash
> git fetch origin && git diff --stat origin/main origin/dev
> ```
>
> Contar commits de diferença não funciona aqui: cada versão liberada para a `main` entra como
> um único commit (squash), então a contagem sempre mostra dezenas de commits mesmo quando o
> conteúdo das duas branches é idêntico. O que importa é o conteúdo — por isso comparamos os
> arquivos, não o histórico. Interprete o resultado assim:
>
> - **Nenhuma saída** — as branches têm o mesmo conteúdo. Pode instalar.
> - **Poucos arquivos, e nenhum deles código do painel** — documentação (`README.md`, `docs/`,
>   `comoFuncionaSistema/`) ou testes (`*.test.ts`). É trabalho em andamento que não muda nada do
>   que roda na sua máquina. Pode instalar.
> - **Arquivos dentro de `apps/` ou `packages/`** — há código de produção na `dev` que ainda não
>   foi promovido para a `main`. Aí sim, [abra uma issue](https://github.com/kelvindk9w/tws-panel/issues)
>   avisando, porque pode ser uma correção de segurança não publicada, e aguarde a promoção — a
>   `dev` é a branch de desenvolvimento e não passa pelo mesmo processo de validação da `main`.

**7. Rode o instalador** — ele instala o Docker se necessário, builda a imagem e sobe os containers:

```bash
./scripts/install.sh
```

> [!NOTE]
> O instalador precisa de privilégios de administrador (instalar Docker, criar volumes, abrir
> portas). Você **não precisa digitar `sudo`**: rodando como o seu usuário comum, ele detecta
> isso e se reexecuta via `sudo` sozinho, pedindo a sua senha. Se preferir ser explícito,
> `sudo ./scripts/install.sh` faz exatamente a mesma coisa — os dois caminhos são equivalentes.

Não precisa de `sudo` na frente: ao detectar que está rodando como usuário comum, o script **se
reexecuta via sudo automaticamente** (chamar `sudo ./scripts/install.sh` também funciona — os dois
caminhos são equivalentes). No final, ele ainda te adiciona ao **grupo docker**, para os comandos
do dia a dia não precisarem de sudo (vale a partir do próximo login).

> [!NOTE]
> **🩺 Pré-flight check:** antes de instalar qualquer coisa, o instalador faz verificações
> **somente-leitura** (SO, RAM/disco, Docker e containers em execução, portas 80/443/9000/25/587/993
> e serviços como nginx, apache, caddy, postfix, mysql e postgres) e exibe um relatório. Se a VPS já
> estiver em uso, ele avisa que o painel foi feito para uma VPS limpa e pede confirmação explícita
> (digite `continuar`) — ou use `./scripts/install.sh --force` / `PAAS_FORCE=1` em automação. Ele
> **nunca remove nem para** nada que já exista na máquina.

<details>
<summary>🩺 <strong>Pré-flight: o que aparece na tela e o que fazer em cada cenário</strong></summary>

**Cenário 1 — VPS limpa (o esperado):** o relatório sai todo verde e a instalação segue
sozinha, sem pedir nada:

```text
[tws-panel] Pré-flight: inspecionando a máquina (nada será alterado nesta etapa)…
  ✓ SO: Ubuntu 24.04.2 LTS (suportado)
  ✓ RAM: 1984 MB
  ✓ Disco livre em /: 23 GB
  ✓ Docker: ausente (será instalado por este script)
  ✓ Nenhum container Docker em execução
  ✓ Portas 80/443/9000/25/587/993 livres
[tws-panel] Máquina limpa detectada ✓ — prosseguindo com a instalação.
```

Não precisa fazer nada — só aguardar o build (leva alguns minutos na primeira vez).

**Cenário 2 — VPS já em uso:** o relatório mostra itens com `⚠` e o instalador **para e
espera sua decisão**:

```text
  ⚠ Portas em uso: 80 443
  ⚠ Serviço ativo: nginx

================================================================================
  ⚠️  ATENÇÃO: esta VPS NÃO parece estar limpa (2 ponto(s) acima).

  O TWS Panel foi feito para uma VPS Ubuntu LIMPA. Continuar pode causar
  conflitos (portas, serviços, recursos) com o que já existe na máquina.
  Este instalador NUNCA remove ou para nada que já exista — mas os
  serviços do painel podem falhar ao subir se as portas estiverem ocupadas.

  Para prosseguir mesmo assim, digite "continuar" — ou rode com
  --force (PAAS_FORCE=1) em automações.
================================================================================

Digite "continuar" para prosseguir:
```

**O que fazer:**

- **Recomendado:** pressione **Ctrl+C** (ou simplesmente não digite nada e feche) para
  abortar — nada foi instalado nem alterado. Resolva os conflitos (ex.: desative o nginx se
  ele não é mais usado, ou contrate uma VPS limpa) e rode o instalador de novo.
- **Se você sabe o que está fazendo** (ex.: o serviço listado não usa as portas do painel):
  digite `continuar` e pressione Enter. Ao digitar, você confirma que **leu o relatório e
  aceita o risco** de conflitos.

**Erros comuns:**

- **Digitou errado (`continua`, `Continuar`)** — o instalador aborta com
  `Instalação abortada. Nada foi instalado ou alterado.` É só rodar de novo.
- **Não use `--force` no seu primeiro contato** — ele pula exatamente a reflexão que este
  aviso quer provocar. O `--force` existe para automação, não para pressa.

</details>

> [!IMPORTANT]
> **Antes de abrir o painel: o link que o instalador imprime é HTTP puro, sem criptografia.**
> O instalador termina mostrando algo como `http://SEU_IP:9000/?token=...`, e o navegador vai
> marcar esse endereço como **"Não seguro"**. Não é alarme falso: é uma VPS com IP público, sem
> TLS. Tudo que passa por ali — o setup token e, principalmente, a **senha da conta de
> administrador** que você cria no passo 4 do wizard — viajaria legível pela internet. Ao
> contrário do token, essa senha não expira: é a credencial permanente de um painel com acesso
> ao socket do Docker (equivalente a root na máquina).
>
> **Recomendado — abra por túnel SSH.** Você já tem uma sessão SSH nesta VPS, então isso não
> exige nada novo. No **seu computador** (não na VPS), abra uma **segunda janela** de terminal —
> deixe a primeira aberta — e rode:
>
> ```bash
> ssh -L 9000:localhost:9000 SEU_USUARIO@SEU_IP
> ```
>
> Com essa janela aberta, acesse `http://localhost:9000/?token=SEU_TOKEN` no navegador. Ele
> ainda vai mostrar **"Não seguro"** — é `http://localhost`, e dessa vez não tem problema: o
> tráfego viaja criptografado dentro do túnel SSH e nada sai da sua máquina em texto claro.
>
> No Windows 10/11, o PowerShell já vem com `ssh` nativo — o mesmo comando acima funciona sem
> instalar nada. No PuTTY, o equivalente fica em Connection → SSH → Tunnels (Source port `9000`,
> Destination `localhost:9000`, Local).
>
> **Acesso direto pelo link do IP** só é tolerável em ambiente de teste descartável, cuja senha
> de admin você não vai reaproveitar em lugar nenhum.

**8. Abra o painel** — pelo túnel SSH acima (recomendado) ou, se aceitar o risco descrito acima, direto em `http://SEU_IP:9000` — cole o **setup token** exibido no terminal e siga o wizard:

```
┌─────────────────────────────────────────────────────────────┐
│  Assistente de configuração — http://SEU-IP:9000/?token=…   │
├─────────────────────────────────────────────────────────────┤
│  1. Boas-vindas      → valida o setup token e libera o      │
│                        terminal ao vivo do servidor         │
│  2. Saúde da máquina → CPU, RAM, disco, rede — os checks    │
│                        rodam AO VIVO no terminal embutido   │
│  3. Segurança        → scan Lynis → plano → hardening       │
│                        (com rollback automático em 5 min)   │
│  4. Conta admin      → usuário + senha forte do painel      │
└─────────────────────────────────────────────────────────────┘
```

O instalador é **idempotente**: pode ser executado de novo sem quebrar nada (rebuild + restart).
O painel roda 100% em Docker (`docker compose up -d`), com o estado persistido no volume
`paas_data` e acesso ao socket do Docker para gerenciar Caddy, Stalwart e seus projetos.

> [!TIP]
> **Perdeu o setup token?** Recupere a qualquer momento com `./scripts/show-token.sh` ou
> `docker exec tws-panel cat /data/setup-token`.

<details>
<summary>🎫 <strong>Banner final do instalador — e como recuperar o token depois</strong></summary>

Quando a instalação termina, o terminal toca um "bip" e mostra um banner assim:

```text
██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██               ✅  TWS PANEL INSTALADO E RODANDO COM SUCESSO!               ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████

👉  PRÓXIMO PASSO: abra o painel no navegador

Recomendado — acesse por túnel SSH.

  1) Numa janela NOVA do terminal, no SEU COMPUTADOR (não na VPS), deixe aberto:

      ssh -L 9000:localhost:9000 SEU_USUARIO@203.0.113.10

  2) Com essa janela aberta, abra no navegador:

      http://localhost:9000/?token=<seu-token-de-48-caracteres>

Direto pelo IP — sem criptografia; use só em rede confiável ou ambiente de
teste descartável:

      http://203.0.113.10:9000/?token=<seu-token-de-48-caracteres>

┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   <seu-token-de-48-caracteres>                                            │
│                                                                          │
│   ⚠  Ele aparece SÓ AGORA em destaque. Guarde-o até concluir o wizard.   │
│   ⚠  Após criar sua conta admin (passo 4 do wizard), ele é invalidado.   │
└──────────────────────────────────────────────────────────────────────────┘
```

**O que fazer:** veja a explicação completa **acima** (túnel SSH recomendado). O link direto
pelo IP funciona, mas trafega sem criptografia — copie o **link completo**
(`http://SEU-IP:9000/?token=...` ou, pelo túnel, `http://localhost:9000/?token=...`) e cole no
navegador. O link já leva o token embutido — não precisa digitar nada.

**Fechou o terminal e perdeu o banner?** Sem pânico. Na VPS, rode qualquer um dos dois:

```bash
./scripts/show-token.sh                       # reexibe o link completo + token
docker exec tws-panel cat /data/setup-token   # mostra só o token
```

**Erros comuns:**

- **`permission denied while trying to connect to the Docker daemon socket`** — faça
  logout/login uma vez (o instalador te adicionou ao grupo docker) ou rode com `sudo`.
- **`setup token não encontrado... O painel está instalado?`** — o `show-token.sh` foi rodado
  numa máquina sem o painel instalado. Rode-o na VPS certa, de dentro de `/opt/tws-panel`.
- **O token não funciona mais no navegador** — depois que você cria a conta admin (passo 4
  do wizard), o token é **invalidado para sempre**. A partir daí o acesso é pela tela de
  login, com seu usuário e senha do painel.

</details>

Depois do wizard: cadastre um projeto, aponte o DNS, e o painel cuida do build, do proxy e do
SSL. Guia completo de produção em [docs/production.md](docs/production.md).

### Comandos úteis (produção)

```bash
docker compose ps            # status do painel
docker compose logs -f panel # logs em tempo real
docker compose up -d --build # atualizar para uma nova versão (git pull antes)

./scripts/show-token.sh      # reexibe a URL + setup token (se você perdeu o token)
./scripts/reset-setup.sh     # recomeça o wizard do zero (--full apaga também usuários/sessões)
```

> [!NOTE]
> Se `docker compose ps` reclamar de permissão, faça logout/login uma vez (o instalador te
> adicionou ao grupo docker) — ou rode os comandos com `sudo`.

### Modo dev local

```bash
pnpm install
SETUP_TOKEN=dev-token pnpm dev
# ou, com Docker:
SETUP_TOKEN=dev-token docker compose -f docker-compose.dev.yml up
```

- Painel (build de produção servido pela API): `http://localhost:9000`
- Frontend com hot reload: `http://localhost:5173` (proxy `/api` → 9000)
- Wizard: `http://localhost:5173/setup` com o token `dev-token`
- Domínios de projeto: use `*.localhost` (servidos em HTTP puro pelo Caddy, sem SSL)

Exemplos prontos para deploy em [`examples/`](examples/README.md).

> [!WARNING]
> Os exemplos são **apenas para testes** — não os use como base de produção sem revisão.

> [!IMPORTANT]
> 🔒 **Validação automática:** o `pnpm install` ativa hooks locais de pre-commit
> (arquivos proibidos + scan de segredos + typecheck incremental) e pre-push
> (testes + cobertura + build). O CI no GitHub Actions é o portão final —
> detalhes no [CONTRIBUTING.md](CONTRIBUTING.md).

## Arquitetura

Monorepo pnpm com TypeScript estrito de ponta a ponta:

```
tws-panel/
├── apps/
│   ├── server/                  # API Fastify: wizard, projetos, domínios,
│   │                            # e-mail, segurança, alertas e auditoria
│   └── web/                     # SPA React (Vite + Tailwind + shadcn/ui):
│                                # wizard /setup + dashboard dark pt-BR
├── packages/
│   ├── core/                    # tipos e constantes compartilhados
│   ├── security/                # engine de scan + hardening + baseline/diff
│   ├── deploy/                  # detecção, ingestão, guardrails, Caddy, pipelines
│   └── mailer/                  # Stalwart, DKIM, checklist DNS, blacklist
├── scripts/
│   ├── install.sh               # instalador one-shot (idempotente, 100% Docker)
│   ├── hardening/               # scripts shell idempotentes por fase (00–06)
│   └── test-*.mts               # suítes de verificação (Fases 3 e 4)
├── examples/                    # apps de exemplo para deploy (apenas testes)
├── docs/                        # specs, guias de produção e troubleshooting
├── Dockerfile                   # build multi-stage do painel (produção)
├── docker-compose.yml           # produção: painel na porta 9000
└── docker-compose.dev.yml       # dev local com hot reload
```

Como os módulos se relacionam:

```
                    ┌─────────────┐
        browser ───►│  apps/web   │ (SPA: wizard + dashboard)
                    └──────┬──────┘
                           │ /api
                    ┌──────▼──────┐      ┌───────────────┐
                    │ apps/server │─────►│ @paas/security│──► host (Lynis, UFW,
                    │  (Fastify)  │      └───────────────┘    fail2ban, baseline)
                    └──┬───┬───┬──┘
                       │   │   │      ┌───────────────┐
                       │   │   └─────►│  @paas/deploy │──► Docker + Caddy central
                       │   │          └───────────────┘    (SSL automático)
                       │   │          ┌───────────────┐
                       │   └─────────►│ @paas/mailer  │──► Stalwart (SMTP/IMAP/DKIM)
                       │              └───────────────┘
                       │              ┌───────────────┐
                       └─────────────►│   @paas/core  │ (tipos compartilhados)
                                      └───────────────┘
        Estado persistido no volume paas_data (/data, arquivos JSON, modo 0600)
        — sem serviços externos.
```

## Roadmap

| Item | Descrição |
|---|---|
| 2FA TOTP | Segundo fator no login do painel |
| MTA-STS / TLS-RPT | Política de TLS obrigatório + relatórios de falha |
| BIMI | Logo verificado (requer DMARC endurecido + VMC) |
| Warm-up de IP | Assistente de aquecimento de reputação para IPs novos |
| Backups na UI | Agendamento/restore de volumes Docker pela interface |
| Multi-servidor | Gerenciar várias VPS a partir de um painel (v2) |

Fases já entregues: **0** Fundação · **1** Hardening · **2** Deploy + Domínios ·
**3** E-mail · **4** Guardrails + Monitoramento · **5** Polish open source.

## Segurança

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Leia [SECURITY.md](SECURITY.md)
para saber como reportar de forma responsável.

O painel foi desenhado com segurança em mente: wizard protegido por token de uso único, Docker
socket nunca exposto via TCP, CORS same-origin por padrão, rate limiting, validação de schema em
todas as rotas da API, logs com redação de segredos e auditoria de todas as ações sensíveis.

> [!TIP]
> Duas fases do hardening (Passo 3 do wizard) merecem atenção antes de rodar:
>
> - **Fase 05 (Minimização)** remove o `snapd` e o bloqueia. Se algum programa seu depende de
>   snap, saiba disso antes — o rollback dessa fase restaura a configuração do APT, mas **não
>   reinstala** os pacotes removidos.
> - **Fase 06 (Auditoria)** demora vários minutos: ela cria a baseline do AIDE varrendo o sistema
>   de arquivos. Parece travada, mas não está.

**Seja franco sobre o que isto exige.** Um PaaS precisa de acesso privilegiado ao host — não há
como criar containers e configurar firewall sem ele. Duas consequências que você deve conhecer
antes de instalar:

- **O terminal web é um shell real com root na VPS**, não uma lista de ações pré-aprovadas. É o
  que permite ver e conduzir o hardening como se estivesse no SSH, e é também o ponto mais
  sensível do sistema: quem tem sessão no painel tem a máquina.
- **O socket do Docker é montado no container do painel**, o que equivale a root no host. É uma
  propriedade do Docker, não uma falha do painel, e nenhum hardening do container altera isso.

Ambos estão documentados em detalhe, junto com o que o projeto **não** protege e as dívidas de
segurança conhecidas, em [comoFuncionaSistema/global/threat-model.json](comoFuncionaSistema/global/threat-model.json).
Recomendamos não expor o painel à internet aberta: prefira VPN ou restrição por IP.

**Autenticação:** o painel nasce protegido pelo setup token gerado na instalação; no Passo 4 do
wizard você cria a conta de administrador (senha com hash argon2id, mínimo de 12 caracteres com
maiúsculas, minúsculas e números), o que conclui o setup e invalida o token para sempre. Daí em
diante todo acesso exige login (`/login`): as sessões são revogáveis, persistidas no servidor
(cookie httpOnly, SameSite=Lax, expiração de 12h — nada de JWT stateless), o login tem rate limit
de 5 tentativas/minuto por IP com lockout progressivo, e trocar a senha invalida as demais sessões.
Login, logout, falhas e criação da conta admin ficam registrados no log de auditoria.

## Perdi o acesso — e agora?

O hardening fecha portas de propósito, e isso corta caminhos de volta. Esta seção existe para
você não descobrir isso no pior momento. Achou seu caso na tabela? Vá direto para ele.

| O que você perdeu | O que ainda funciona | Caminho de volta |
|---|---|---|
| Senha do **painel** (login web) | SSH na VPS | `./scripts/reset-setup.sh --full` |
| Senha do **usuário Linux** (a do `sudo`) | SSH + painel | Terminal do painel → `passwd SEU_USUARIO` |
| **Chave SSH** | Painel acessível | Terminal do painel → recoloca a chave |
| **Chave SSH** | Console do provedor | Login com usuário e senha → recoloca a chave |
| Tudo acima | — | Modo de recuperação (rescue) do provedor |

> [!IMPORTANT]
> **Confirme o seu caminho de recuperação ANTES de aplicar o hardening.** Entre no painel do seu
> provedor e procure por "Console", "VNC", "Rescue" ou "Modo de recuperação". Se você não achar
> nenhum, a prevenção descrita no Passo 4 deixa de ser recomendação e passa a ser obrigatória:
> sem console, não existe rede de segurança e uma chave perdida pode significar reinstalar a
> máquina do zero.

### Perdi a senha do painel

A conta de administrador do painel é independente do sistema. Com acesso SSH à VPS, apague a
conta e refaça o Passo 4 do wizard:

```bash
cd /opt/tws-panel
./scripts/reset-setup.sh --full
./scripts/show-token.sh
```

O primeiro comando apaga a conta admin e todas as sessões (pede confirmação: digite `resetar`).
O segundo mostra o setup token de novo, para você reabrir o wizard e criar uma conta nova.

**Seus projetos, domínios, e-mail e histórico de segurança não são tocados.**

### Perdi a senha do usuário Linux

Essa é a mais traiçoeira, porque parece que está tudo bem: a chave SSH ainda te deixa entrar, mas
nenhum `sudo` funciona — e o hardening travou a senha do root, então não dá para virar root pelo
caminho normal.

A saída é o **terminal embutido do painel**, que roda como root. No painel, abra o terminal e
rode:

```bash
passwd SEU_USUARIO
```

Defina a nova senha e pronto. Se o painel também estiver inacessível, vá para o console do
provedor ou o modo de recuperação.

### Perdi a chave SSH

Você precisa reinstalar uma chave nova em `~/.ssh/authorized_keys` do seu usuário. Gere um par
novo no seu computador (Passo 4) e use um dos caminhos abaixo, na ordem:

**1. Pelo terminal do painel** — se você ainda consegue entrar no painel. Ele roda como root, então
acrescente a chave direto:

```bash
echo "COLE_AQUI_A_NOVA_CHAVE_PUBLICA" >> /home/SEU_USUARIO/.ssh/authorized_keys
```

**2. Pelo console do provedor** — o acesso via navegador não passa pelo SSH, então a restrição de
login por senha não vale ali. Entre com o seu usuário e a senha, e rode o mesmo comando (sem o
caminho completo, já que você está logado como ele):

```bash
echo "COLE_AQUI_A_NOVA_CHAVE_PUBLICA" >> ~/.ssh/authorized_keys
```

**3. Pelo modo de recuperação** — último recurso. O provedor inicia a máquina por outro sistema e
monta o seu disco, permitindo editar o `authorized_keys` de fora. O procedimento varia por
provedor; procure na documentação dele por "rescue mode".

> [!WARNING]
> Sempre `>>`, nunca `>`. Um `>` sozinho **apaga** as chaves que já estavam lá — inclusive a que
> você talvez ainda estivesse usando. Confira o resultado com `cat ~/.ssh/authorized_keys` antes
> de fechar a sessão, e teste a conexão numa janela nova **antes** de encerrar a que funciona.

### O paradoxo do terminal do painel

Você deve ter notado que o terminal embutido aparece duas vezes como salvação. Ele roda como root
na máquina, o que é exatamente o motivo de ele ser o ponto mais sensível do sistema — e, pelo
mesmo motivo, a porta dos fundos quando tudo o mais falha.

Vale saber que é assim, e decidir conscientemente: manter o painel acessível é uma rede de
segurança, mas é também a maior superfície de ataque da instalação. Se você optar por restringir
o acesso a ele, garanta antes que o console do seu provedor funciona.

## Documentação

| Doc | Conteúdo |
|---|---|
| [docs/production.md](docs/production.md) | Do dev à VPS real: portas, DNS, ACME, PTR, ordem recomendada |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Porta 25 bloqueada, e-mail em spam, cert não emitido, wizard inacessível… |
| [docs/README.md](docs/README.md) | Índice completo da documentação |
| [comoFuncionaSistema/](comoFuncionaSistema/) | Documentação legível por máquina: um JSON por endpoint, com parâmetros, erros, efeitos colaterais e testes. Escrita para agentes de IA — comece por `index.json` |
| [threat-model.json](comoFuncionaSistema/global/threat-model.json) | O que o painel protege, o que não protege, quais privilégios exige e por quê |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Como contribuir (setup, padrões, como estender o painel) |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Código de conduta |
| [SECURITY.md](SECURITY.md) | Política de segurança e reporte de vulnerabilidades |

## Sobre a TWS

O **TWS Panel** é um projeto open source mantido pela **TWS**, software house fundada e liderada
pelo CEO **Kelvin**. A TWS desenvolve soluções web, sistemas e automações sob medida para
clientes — e este projeto nasceu de uma dor real da própria empresa: pagar hospedagem cara
praticamente só para ter e-mail profissional. Em vez de ficar só no uso interno, decidimos
liberar o painel para a comunidade, sob licença MIT.

Quer conversar sobre parcerias, projetos ou contribuições?

- 🌐 Site: [tws.tec.br](https://tws.tec.br/)
- ✉️ E-mail: [contato@tws.tec.br](mailto:contato@tws.tec.br)
- 💼 LinkedIn: [Kelvin Medeiros](https://www.linkedin.com/in/kelvin-medeiros-37920487)

**Autor:** Kelvin — CEO & Founder @ TWS

## Licença

[MIT](LICENSE) © 2026 TWS — Kelvin
