---
title: "Solução de problemas"
description: "Soluções para problemas comuns: porta 25 bloqueada, e-mail em spam, certificado que não sai, painel que não abre, acesso SSH perdido e deploy bloqueado."
sidebar:
  label: "Solução de problemas"
---

Problemas prováveis ao rodar o TWS Panel em uma VPS real e como resolver cada um.

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês: mensagens da checagem de DNS e de certificado, status do servidor de e-mail, alertas, detalhes da auditoria e muitas mensagens de erro. Quando esta página cita uma delas, avisa.

---

## E-mail

### Porta 25 bloqueada pelo provedor

**Sintomas:** você envia e recebe e-mails internamente, mas nenhuma mensagem de fora chega;
testes de conexão na porta 25 falham (`telnet SEU-IP 25` trava).

**Causa:** muitos provedores (Hetzner, AWS, OCI, contas novas em geral) bloqueiam a porta 25
de saída/entrada por padrão como medida anti-spam.

**Solução:**
1. Abra um chamado no provedor pedindo a liberação da porta 25 (alguns têm opção no painel);
2. Confirme o UFW: `sudo ufw allow 25/tcp`;
3. Verifique do lado de fora: `nc -zv SEU-IP 25`.

### E-mail caindo em spam

**Sintomas:** mensagens enviadas chegam, mas vão direto para a pasta de spam (especialmente
Gmail e Outlook).

**Diagnóstico (nesta ordem):**
1. Envie para [mail-tester.com](https://www.mail-tester.com) — ele aponta exatamente o que
   está faltando. Alvo: ≥ 9/10.
2. Abra o **checklist DNS** do domínio no painel e clique em **Verificar agora**: A, MX, SPF, DKIM e
   DMARC precisam estar ✅.
3. **PTR amarelo** (sem nome reverso válido) é a causa nº 1: só o provedor da VPS configura. O
   card do PTR diz onde trocar (Contabo, Hetzner, Vultr) ou gera o texto pronto do chamado.
4. Confira as **listas de bloqueio** no painel (**Envios → Reputação**). Se estiver listado, use
   **Pedir remoção** na lista correspondente.
5. Veja a nota de entregabilidade em **Envios → Nota**: ela lista o que falta, item por item.
6. **IP novo sem reputação**: nas primeiras 2–4 semanas envie volume baixo e crescente
   (dezenas/dia, não milhares). Veja "warm-up de IP" em
   [email-deliverability.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/internal/email-deliverability.md).
7. Mantenha o DMARC em `p=none` coletando relatórios até tudo estabilizar; endureça para
   `quarantine`/`reject` depois.

### Certificado TLS do Stalwart inválido

**Sintomas:** clientes de e-mail avisam "certificado não confiável" ao conectar.

**Causa:** o certificado de `mail.<domínio>` ainda não foi emitido — enquanto isso o
Stalwart usa um autoassinado. Quase sempre falta o registro A de `mail.<domínio>`
apontando para a VPS, ou ele está com a nuvem laranja na Cloudflare.

**Solução:** abra **E-mail** no painel: o card "Certificado do servidor de e-mail" diz o
que falta. Crie o registro A de `mail.<domínio>` com o IP da VPS (na Cloudflare, nuvem
**cinza**), confira as portas 80 e 443 liberadas e clique em "Conferir de novo". O painel
instala e renova o certificado sozinho.

---

## Domínios e SSL

### Caddy não emite certificado

**Sintomas:** site no ar só em HTTP, erro de ACME nos logs do container `paas-caddy`
(`docker logs paas-caddy`).

**Causa:** o registro A do domínio ainda não aponta para a VPS (ou a propagação não terminou).

**Solução:**
1. Use o botão **Verificar DNS** no painel antes de emitir o certificado;
2. Confira manualmente: `dig +short seudominio.com` deve retornar o IP da VPS;
3. Se acabou de criar o registro, aguarde a propagação (minutos a horas, dependendo do TTL);
4. Se houver proxy na frente (ex.: Cloudflare com nuvem laranja), desative-o para a emissão
   inicial. O painel não tem modo DNS-01: o Caddy central espera conexão direta nas portas 80/443.
   Depois que o certificado sair, use **Tentar emitir agora** na página **Certificados** se ele ainda estiver pendente;
5. Verifique se o UFW/liberação do provedor permite 80 e 443.

### O site abre sem www, mas com www não (ou o contrário)

**Sintoma:** `example.com` abre e `www.example.com` dá erro de conexão (ou o inverso). Na página
**Domínios** do projeto, a linha do par mostra "aguardando o DNS".

**Causa:** cada nome precisa do seu próprio registro de DNS. O painel só pede o certificado do par
(e liga o redirecionamento para o nome principal) depois que o DNS dele aponta para a VPS; antes
disso, o nome não responde.

**Solução:**
1. Em **Domínios → Conectar novo domínio**, digite o nome e veja a orientação: um registro para cada
   nome (`@` e `www`, tipo A com o IP da VPS; o `www` também pode ser um CNAME para o domínio sem www).
2. No Cloudflare, deixe a nuvem **cinza** nos dois. Com a laranja, a linha do par diz que o proxy está
   ligado e o certificado não sai.
3. Clique em **Verificar DNS**: o resultado vem nome por nome. O par que falha é só aviso.
4. Se a linha disser "já é de outro projeto", "é do painel" ou "é do servidor de e-mail", o painel não
   toma o nome: use outro projeto ou remova o nome de lá.
5. Para não ter o redirecionamento, clique em **Desligar** na linha do par.

**Limites conhecidos (documentados, não implementados):** a verificação do DNS do par lê só registros A
(IPv4); um registro AAAA apontando para outro lugar não é detectado. Depois de reiniciar o painel sem
resposta de DNS, um par que já redirecionava só é mantido quando a primeira conferência responder; até
lá ele não é recriado.

<a id="verificacao-do-dominio-de-aplicacoes"></a>

### A verificação do domínio de aplicações falha

**Sintomas:** em **Configurações → Domínio de aplicações**, **Verificar DNS e salvar** mostra "Não foi
salvo" e uma mensagem do servidor, em português mesmo com a interface em inglês.

**Causas e soluções:**

- **Só existe o registro do nome exato** (`apps.example.com`). A verificação consulta um nome
  aleatório (`paas-check-…apps.example.com`), então só um registro **curinga** (`*.apps`) passa. Crie
  o registro com o nome `*.apps` (ou `*.apps.example.com`, conforme o provedor).
- **Nuvem laranja da Cloudflare:** a mensagem fala em "proxy da Cloudflare". Mude o registro curinga
  para a nuvem cinza ("Somente DNS"). Atrás do proxy, o certificado de cada projeto não sai.
- **IP errado, ou mais de um registro A:** deixe só o IP da VPS.
- **Registro AAAA para outro lugar:** apague o AAAA curinga (ou aponte para o IPv6 da VPS, se o painel
  o conhece).
- **"O DNS não respondeu agora":** nada foi salvo e nada mudou; tente de novo em instantes.
- **Acabou de criar o registro:** espere a propagação (minutos a horas) e verifique de novo.
- Confira de fora: `dig +short qualquer-coisa.apps.example.com` deve devolver o IP da VPS.

<a id="limite-do-lets-encrypt"></a>

### Certificado de um projeto não sai (limite do Let's Encrypt)

**Sintomas:** o navegador mostra erro de certificado ao abrir o projeto (o Caddy redireciona o HTTP para
HTTPS), e a página **Certificados** mostra o domínio como "Falhou".

**Causa:** o Let's Encrypt limita a **50 certificados novos por semana por domínio registrado** (para
`projeto-k3x9q.apps.example.com`, o domínio registrado é `example.com`), e a 5 certificados idênticos
por semana. Criar e apagar muitos projetos em poucos dias esgota o limite dos 50. O limite dos idênticos
só atinge domínio próprio (repetir o mesmo nome): cada endereço sob o domínio de aplicações ganha um
sufixo novo a cada criação.

**Solução:**
1. Abra **Certificados** e leia a causa que o painel mostra (mensagem do servidor, em português).
2. Se for o limite, espere: ele volta aos poucos ao longo da semana. O painel não consegue contorná-lo.
3. Depois, clique em **Tentar emitir agora**. Enquanto isso o painel segue com as tentativas
   automáticas, com intervalo crescente.
4. Para não gastar o limite à toa, não apague e recrie projetos várias vezes. No assistente, o projeto é
   criado com um endereço provisório (`nome-xxxxx.localhost`, único, sem IP e sem certificado público) e só troca para o endereço sob a base ao clicar em **Criar projeto**.

### Projeto com endereço provisório (`nome-xxxxx.localhost`)

**Sintomas:** o projeto mostra um aviso âmbar "Endereço provisório" e o endereço `nome-xxxxx.localhost` não abre.

**Causa:** o assistente cria o projeto com esse endereço provisório e só o troca ao clicar em **Criar projeto**.
Se você fechou o assistente antes, o projeto ficou com ele. `.localhost` sempre aponta para o computador de quem
acessa, não para a VPS, então ele não funciona num painel público.

**Solução:** abra o projeto, vá em **Domínios** (o aviso tem o atalho) e troque o endereço:
- com o domínio de aplicações configurado, clique em **Usar o endereço automático (…)**: o painel adiciona o
  endereço sob a base, o torna principal e remove o provisório (se algo falhar, clique de novo e ele continua de
  onde parou);
- sem o domínio de aplicações, a tela explica as saídas: **Configurar o domínio de aplicações** (em Configurações)
  ou **Conectar novo domínio** com um domínio seu.

Não edite o `/etc/hosts`: isso não faz o
site da VPS aparecer.

### Domínio `.localhost` não abre (painel na sua máquina)

**Sintomas:** `meuapp.localhost` não resolve no navegador, com o painel rodando no seu próprio computador.

**Solução:** `.localhost` depende do sistema operacional resolver para 127.0.0.1 — funciona
nativamente no Linux/macOS modernos e no Chrome; se falhar, adicione ao `/etc/hosts`:
`127.0.0.1 meuapp.localhost`. Isso vale só para o painel local. Em dev, lembre-se de que `.localhost` é servido em **HTTP puro**.

---

## Painel e wizard

### Painel não abre depois do `install.sh`

**Sintomas:** o endereço `https://SEU-IP-COM-HÍFENS.sslip.io/?token=...` não abre, ou o
instalador avisa que ele não respondeu em 3 minutos.

**Checklist (na VPS, em `/opt/tws-panel`):**
1. Os containers estão de pé? `sudo docker compose ps`;
2. O certificado saiu? A causa mais comum são as portas **80 e 443 bloqueadas** num firewall do
   provedor (no painel da hospedagem): libere as duas e rode `sudo docker compose restart`. Para
   ver o que o proxy diz: `sudo docker logs paas-caddy --tail 50`;
3. Enquanto isso, o acesso por túnel SSH funciona: o banner do instalador mostra o comando
   (veja [Acesso por túnel SSH](../getting-started/installation.md#acesso-por-tunel));
4. Token correto? Reexiba o link completo com `sudo ./scripts/show-token.sh`.

O painel em si escuta só dentro da VPS (`127.0.0.1`): o endereço `http://SEU-IP:9000` não abre,
de propósito.

### Salvar ou clicar falha com `403 forbidden_origin`

**Sintomas:** o painel abre, mas as ações que gravam (salvar, entrar, fazer deploy) voltam
`403 forbidden_origin`. Acontece quando você abre o painel atrás de **outro proxy** (um balanceador,
um túnel, um CDN) que remove o cabeçalho `Sec-Fetch-Site` ou reescreve o `Origin`. Atrás do Caddy que
o próprio painel instala, não é preciso configurar nada.

**Correção (na VPS, em `/opt/tws-panel`):**
1. Acrescente ao `.env` a origem exata em que você abre o painel, sem barra no fim; separe várias
   com vírgula. Não use `*`:

   ```
   ALLOWED_ORIGINS=https://painel.example.com
   ```

2. Recrie o container para ele ler a variável:

   ```bash
   sudo docker compose up -d
   ```

A variável vem vazia por padrão, e então só a origem do próprio painel é aceita.

### "Token inválido" no wizard

**Sintoma:** o assistente diz "Token inválido. Confira o valor exibido pelo instalador no terminal."

**Causa:** token errado, copiado com espaço extra, ou o servidor foi reiniciado com outro
`SETUP_TOKEN` no ambiente.

**Solução:** o arquivo `/data/setup-token` (volume `paas_data`) tem prioridade sobre a variável
`SETUP_TOKEN` do ambiente, que é só o ponto de partida da instalação. Reexiba a URL + token com
`sudo ./scripts/show-token.sh` (lê o volume, sem reinstalar nada). Ao concluir o assistente o token é
apagado de propósito; para reabrir o assistente e gerar um token novo, rode
`sudo ./scripts/reset-setup.sh` (ou `--full`, que também apaga a conta de administrador).

### Perdi o token / quero recomeçar o wizard do zero

- **Perdeu o token:** `sudo ./scripts/show-token.sh` — imprime o banner com a URL e o token.
- **Recomeçar o wizard:** `sudo ./scripts/reset-setup.sh` — apaga `setup-state.json` do volume
  (com confirmação interativa) e o wizard volta ao passo 0; a conta admin é mantida.
  Com `--full` apaga também `users.json` e `sessions.json` (a conta admin deixa de existir
  e todos são deslogados). Os dois modos geram um setup token NOVO (o antigo deixa de valer; veja com
  `show-token.sh`). Projetos, domínios e e-mail NÃO são tocados.

### Perdi o acesso SSH durante o hardening

**Não entre em pânico — é para isso que existe o rollback.** O hardening agenda uma reversão
automática (via `at`) que restaura a configuração anterior em ~5 minutos **se você não
confirmar o acesso** pelo painel. Aguarde o rollback, entre novamente e revise o plano de
correções antes de reaplicar. Cada arquivo alterado tem backup em `/var/backups/paas/`.
Perdeu a chave, a senha ou o celular da verificação em duas etapas? Veja
[Perdi o acesso: e agora?](recover-access.md).

### Deploy bloqueado por guardrail

**Sintomas:** deploy retorna `409 guardrail_blocked` e a UI abre o modal de blockers.

**Solução:** o modal lista cada violação com **evidência** (arquivo:serviço) e **sugestão de
correção**. Corrija o compose/código (recomendado) — ex.: remova a porta do banco publicada no
host, troque credenciais fracas. Se tiver certeza do risco (ex.: banco exposto só em ambiente
de homologação), marque **Entendo os riscos e quero fazer o deploy mesmo assim (override)** e confirme o override — ele fica **auditado** em
Auditoria (`guardrail.override`). Quatro regras protegem o próprio painel e não aceitam override
(`panel-resource`, `network-hijack`, `reserved-name`, `panel-image`): o compose precisa mudar.
O que cada regra barra, como ler a mensagem e exemplos de antes e depois estão em
[Como escrever um compose que o painel aceita](compose-rules.md).

---

### "You have to authenticate first" no servidor de e-mail depois de restaurar

A senha de administração do servidor de e-mail guardada no painel e a que está na configuração do
servidor em execução são diferentes (acontece depois de restaurar o painel ou o e-mail). O painel
confere isso depois da restauração e tenta corrigir, e **Sincronizar com o servidor de e-mail**
também tenta o reparo uma vez antes de mostrar erro. Se ainda aparecer "O painel não conseguiu
autenticar no servidor de e-mail", clique em **Reparar agora** (na própria tela de **E-mail**, junto
da mensagem, ou no aviso âmbar do Dashboard), ou pare o servidor de e-mail e inicie de novo em
**E-mail**. Nenhum dado é apagado. Detalhes em
[Restaurar em outro servidor](restore-new-server.md#se-algo-falhar).

### "535 5.7.8 Authentication credentials invalid" no teste de notificação por e-mail

O servidor de e-mail recusou o login da caixa `postmaster@` porque a senha que o painel guardou não é a que o servidor tem (acontece depois de restaurar o e-mail: a caixa volta com a senha do backup). O painel mostra "a senha guardada pelo painel não é a do servidor" e, em **Configurações → Notificações**, o botão **Abrir E-mail para sincronizar**. Em **E-mail**, clique em **Sincronizar com o servidor de e-mail**: ele confere e reaplica a senha que o painel guarda para a `postmaster@` e para as caixas de projeto ("Realinhei a senha de N caixas"). Se preferir, use **Trocar senha** na caixa `postmaster@` do domínio. Só as senhas que diferem são regravadas. Atenção: a senha de uma caixa de **projeto** (ou da `postmaster@`) trocada direto no webmail é desfeita por esse passo; caixa de usuário comum não é tocada. Depois, envie o teste de novo. Detalhes em [Restaurar em outro servidor](restore-new-server.md#se-algo-falhar).

## Docker

### "Cannot connect to the Docker daemon"

**Solução:** `systemctl status docker` — se o `install.sh` acabou de instalar, pode ser
necessário `sudo systemctl enable --now docker`. O painel acessa apenas o socket local
(`/var/run/docker.sock`); nunca exponha o Docker via TCP.

### Conferir se o projeto voltou bem depois de reiniciar a VPS

Abra o projeto e vá na aba **Logs**. No topo, cada serviço mostra se está **rodando**, se está
**saudável**, quantos **reinícios** teve e desde quando está no ar. Um serviço "reiniciando sem
parar" ou "com problema" é o que precisa de atenção: escolha-o no seletor **Serviço** e leia as
últimas linhas (as de erro vêm marcadas). Se a aba disser que o projeto está **parado**, use
**Iniciar** no topo da página do projeto. Se disser que o **Docker não está respondendo**, o
problema é da máquina, não do projeto: veja `systemctl status docker` na VPS.

### O Dashboard diz "Monitoramento em modo reduzido" ou mostra "Sem dados"

- **"Modo reduzido"**: o container do painel foi criado antes da atualização que trouxe as montagens do servidor (`/proc` e
  `/sys/fs/cgroup`, somente leitura). Recrie-o: `cd /opt/tws-panel && sudo git pull && sudo docker compose up -d --build`
  (um `docker restart` não pega montagens). Para conferir: `sudo docker inspect tws-panel --format '{{json .Mounts}}'`.
- **"Sem dados" logo depois da atualização**: a primeira medida leva cerca de 1 minuto; as taxas (CPU, rede, disco) precisam de duas
  leituras, então aparecem a partir do segundo minuto.
- **"A última gravação das medidas falhou"**: confira o espaço livre em disco da VPS (`df -h`); o painel nunca para por isso,
  apenas fica sem guardar histórico até haver espaço.
- **"Steal" do provedor sempre em 0**: normal em alguns tipos de virtualização que não o informam; não é erro.

---

## Não achou seu problema?

Abra uma issue no repositório com o template de bug — inclua logs (sem segredos), versão do
commit e ambiente. Veja [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/community/pt-BR/CONTRIBUTING.md).
