# Relatório — página Certificados (01/10/2026)

Branch `feat/certificados`, criada a partir de `origin/dev`. Este repositório é público:
nada aqui tem IP real, senha ou nome de cliente. `203.0.113.10` e `exemplo.com.br` são
valores de exemplo.

## O problema

Todo certificado do painel já era automático: o Caddy central (`paas-caddy`) emite e
renova sozinho, pelo Let's Encrypt (ou ZeroSSL), o do painel, o de cada domínio de
projeto e o de `mail.<domínio>` (que o painel copia para o servidor de e-mail). Só que
isso ficava invisível. Validando na VPS, o dono do produto viu o card do e-mail
"pendente" por um tempo e não tinha onde ver o estado de todos os certificados nem um
botão para agir. O pedido dele: "uma parte de configuração do certificado SSL, em que
com um clique o sistema configura o certificado, seja ele manual ou automático, com
renovação", para o painel, os projetos e o e-mail.

## O que mudou (pelo comportamento)

### 1. Página Certificados

Um item novo no menu principal, **Certificados**, entre "E-mail" e "Segurança". A página
lista todos os endereços que o painel serve com HTTPS: o do painel, cada domínio
(principal e adicionais) de cada projeto e cada `mail.<domínio>`. Para cada um aparece:

- **a quem pertence**: Painel, Projeto X ou E-mail;
- **o modo**: Automático ou Manual;
- **o estado**: Válido, Emitindo, Falhou, Vence em breve ou Vencido. Com o proxy fora do
  ar, "Não conferido" e um aviso no topo;
- **o emissor e a data de validade**;
- **no automático**, "renova sozinho por volta de <data>". A data é a validade menos 30
  dias, e a página diz que ela é aproximada.

O estado vem do certificado que o endereço entrega de verdade. O painel abre uma conexão
HTTPS pelo proxy central, do jeito que um navegador abre. Quando ainda não há
certificado, o painel lê o log do Caddy das últimas 24 horas e pega o último evento
daquele nome. Se foi um erro, a página explica a causa provável em linguagem simples:

- o DNS não aponta para a VPS;
- a nuvem laranja da Cloudflare está na frente (o painel também confere se o DNS do nome
  só tem IPs da Cloudflare);
- as portas 80 ou 443 estão fechadas;
- o Let's Encrypt limitou as emissões. Quando o erro traz a data, a página diz a partir
  de quando dá para tentar de novo;
- um registro CAA proíbe o emissor.

O detalhe técnico do erro fica escondido num "Detalhe técnico". Ele é limitado a 300
caracteres e sai sem caracteres de controle.

### 2. "Tentar emitir agora" (botão azul)

O botão aparece nos endereços automáticos que ainda não têm certificado válido. Ele faz o
Caddy recomeçar a emissão na hora, sem esperar o intervalo de espera, que cresce a cada
falha. Depois do clique, a tela acompanha por até 2 minutos e mostra o resultado:
"Certificado emitido!", "A emissão falhou de novo" (com a causa) ou "Ainda não ficou
pronto; o proxy continua tentando sozinho".

O servidor recusa o pedido quando:

- já houve um pedido para o mesmo nome há menos de 1 minuto (a mensagem diz quantos
  segundos faltam);
- o certificado já é válido. A explicação é que não é preciso e que pedir certificados
  repetidos pode bater no limite do Let's Encrypt (5 iguais por semana). Num certificado
  válido, a tela mostra "Renovar agora?", que só explica isso e não chama o servidor;
- o limite do Let's Encrypt para aquele nome ainda vale;
- o nome usa certificado manual.

Para `mail.<domínio>`, assim que o certificado fica válido o painel já o instala no
servidor de e-mail. Isso acontece durante o próprio acompanhamento da tela.

### 3. Certificado próprio (manual)

O botão "Usar certificado próprio" abre dois campos: o certificado, com a cadeia, e a
chave privada. Dá para colar o texto ou carregar o arquivo. O botão verde "Instalar
certificado" envia os dois, e o painel confere o par antes de aceitar. Se algo estiver
errado, a recusa diz o motivo:

- a chave foi colada no lugar do certificado;
- a chave está protegida por senha (a mensagem mostra o comando para tirar a senha);
- o certificado não vale para aquele nome (a mensagem lista os nomes que ele cobre);
- o certificado está vencido ou ainda não começou a valer;
- a chave não é a daquele certificado.

O painel aceita wildcard (`*.exemplo.com.br`) que cubra o nome.

Depois de aceito:

- o par fica guardado no servidor, numa pasta só do painel (permissões 0700 na pasta e
  0600 nos arquivos). A chave nunca volta pela API e nunca vai para log nem auditoria;
- o proxy passa a entregar esse certificado para o nome. Os outros nomes do mesmo
  projeto continuam no automático;
- para `mail.<domínio>`, o servidor de e-mail também passa a usar o certificado próprio;
- a página avisa que o certificado próprio **não renova sozinho** e mostra até quando ele
  vale. A 30 dias do fim aparece um alerta de aviso na página Alertas (nova origem
  "certificado"). A 7 dias aparece um alerta crítico, e outro quando vence;
- "Trocar certificado" envia um novo;
- "Voltar para automático" (vermelho, com confirmação) apaga o par e o Caddy volta a
  emitir sozinho.

Um wildcard próprio também passa a valer para os outros nomes que ele cobre. O Caddy usa
o mesmo certificado e deixa de emitir automático para esses nomes. A página mostra isso
como "Manual — usa o certificado instalado em X".

A auditoria registra a emissão forçada (só o nome) e a instalação e a remoção do
certificado próprio (nome, emissor e validade).

### 4. Resumo no e-mail e nos domínios do projeto

O card "Certificado do servidor de e-mail" (página E-mail) continua como antes. Embaixo
dele aparece um resumo com o modo e o estado de cada `mail.<domínio>` e o link "Ver em
Certificados". A seção Domínios do projeto ganhou o mesmo resumo para os domínios
daquele projeto. Os dois usam o mesmo endpoint da página, com filtro.

## Decisões

- **Item no menu principal, e não aba de Segurança.** Para um leigo, "Certificados" é um
  assunto próprio (o cadeado do site), não uma proteção da VPS. Um item direto no menu é
  um clique só e um nome que a pessoa reconhece. A aba exigiria saber que o certificado
  "mora" em Segurança.
- **"Tentar emitir agora" = `caddy reload --force`.** A documentação oficial diz que
  `--force` recarrega mesmo com a configuração igual. Sem o `--force`, o Caddy ignora a
  recarga, porque o Caddyfile só muda no comentário com a data. No código do certmagic
  (motor de certificados do Caddy):
  - `config.go`, em `manageOne`, enfileira o "obtain" assíncrono **sem nome de job**. O
    comentário do código explica que é justamente porque o Caddy sobe a configuração nova
    antes de parar a antiga. Assim, o pedido novo não é descartado pelo antigo, que ainda
    está esperando;
  - `async.go`, em `doWithRetry`, faz a primeira tentativa sem espera e para quando o
    contexto da configuração antiga é cancelado.

  Certificado já guardado não é reemitido e nada é apagado. Efeito colateral aceito: o
  reload recomeça a emissão de **todos** os nomes sem certificado, não só do clicado. O
  Caddy 2 não tem comando documentado para recomeçar um nome só.
- **Arquivos do manual dentro do container do Caddy pelo mesmo caminho do Caddyfile.** O
  Caddyfile já chega ao container com `docker cp` (tar pela entrada padrão, extraído em
  `/etc/caddy`, na camada gravável). Nunca há bind mount, porque o caminho do painel não
  existe no host. O par vai na mesma cópia, em `/etc/caddy/certs/<id>.crt|.key` (pasta
  0700, arquivos 0600). Ele é regravado em toda sincronização do proxy e junto com o
  Caddyfile quando o container é recriado; sem isso, o Caddy recusaria o Caddyfile por
  arquivo ausente. "Voltar para automático" apaga os dois arquivos com `docker exec rm -f`.
- **Nome manual ganha bloco próprio no Caddyfile.** A diretiva `tls` vale para o bloco
  inteiro. Se o nome manual ficasse junto dos outros domínios do projeto, todos passariam
  a usar o certificado manual.
- **Estado "Emitindo" por até 3 minutos depois do clique**, até aparecer um evento novo no
  log. Sem isso, a tela mostraria o erro antigo logo depois do pedido.
- **Linhas de log são dados não confiáveis.** O painel só extrai campos conhecidos e só
  aceita nome com formato de domínio. Linha acima de 64 KiB é descartada. O texto
  mostrado é limitado e limpo. Nada é executado a partir do log.

## Como testei

- **TDD:** os testes foram escritos antes do código e vistos falhando.
- **Leitura do log do Caddy** (`packages/deploy/tests/caddy-log.test.ts`). Usa as duas
  linhas reais informadas: "certificate obtained successfully" com `identifier` e
  `issuer`, e "trying to solve challenge" com `challenge_type`. Os exemplos de erro
  seguem o formato do certmagic e do ACME: "could not get certificate from issuer" com
  NXDOMAIN, "challenge failed" com `problem{type,detail}` e timeout, "will retry" com o
  nome entre colchetes e `retrying_in`, e `rateLimited` com "retry after". Também cobre
  lixo, linha gigante e caracteres de controle.
- **Caddyfile com `tls` manual e reload forçado**
  (`packages/deploy/tests/caddy-manual-tls.test.ts`): bloco próprio, painel e e-mail,
  arquivos com 0700/0600 na mesma cópia, chave fora do espelho local e do log,
  `--force`, remoção dos arquivos e leitura do log.
- **Conferência do par manual** (`packages/mailer/tests/certificate-pair.test.ts`), com
  certificados gerados pelo openssl na hora: wildcard, nome errado, vencido, ainda não
  vale, chave de outro par, chave com senha e chave no campo errado.
- **Servidor** (`apps/server/tests/certificate-service.test.ts` e
  `routes-certificates.test.ts`): lista e estados, causa Cloudflare pelo DNS, limite de 1
  por minuto, recusa de certificado válido e de limite do Let's Encrypt, validação de
  schema, arquivos 0600/0700, chave nunca na resposta nem na auditoria, wildcard
  "coberto por", alertas de 30 e 7 dias e vencido, e `mail.<domínio>` instalado no
  servidor de e-mail. O teste em `apps/server/tests/mail-tls.test.ts` confere que o
  e-mail prefere o certificado manual.
- **Web** (`apps/web/tests/certificates-page.test.tsx`): estados, botões e cores,
  acompanhamento até ficar válido e até estourar o tempo, 429, envio do manual com
  recusa e sucesso, "Voltar para automático" com confirmação, e o resumo. Os testes de
  `mail-page` e `project-sections` conferem o link "Ver em Certificados".
- **Visual em 390 px** (navegador com a API simulada): a página não tem rolagem lateral,
  inclusive com o formulário do manual e a confirmação abertos.

Suítes, antes → depois:

| Pacote | Antes | Depois |
|---|---|---|
| packages/core | 45 | 45 |
| packages/deploy | 302 | 335 |
| packages/mailer | 150 | 160 |
| apps/server | 880 | 920 |
| apps/web | 407 | 420 |

`tsc --noEmit` limpo nos cinco.

## O que só dá para validar na VPS real

1. **Emissão real e o log real.** Os formatos de erro dos testes seguem o código do
   certmagic e do ACME, mas só a VPS confirma o texto exato. Para ver o log:
   `sudo docker logs paas-caddy --since 24h 2>&1 | grep -E '"(identifier|msg)"' | tail -n 50`.
2. **"Tentar emitir agora"** com um nome que falhou: depois de corrigir o DNS, clicar e
   conferir que o certificado sai em até 2 minutos, sem esperar o intervalo do Caddy. Em
   seguida, `sudo docker logs paas-caddy --since 5m 2>&1 | grep obtain` deve mostrar um
   "obtaining certificate" logo depois do clique.
3. **Certificado próprio de verdade**, por exemplo um wildcard. Instalar, abrir o
   endereço no navegador, conferir o emissor no cadeado e depois clicar em "Voltar para
   automático".
4. **`mail.<domínio>` com certificado próprio no servidor de e-mail.** Conferir com
   `openssl s_client -connect mail.exemplo.com.br:465 -servername mail.exemplo.com.br </dev/null 2>/dev/null | openssl x509 -noout -issuer -enddate`.
5. **Recriação do container `paas-caddy`** (ex.: `sudo docker rm -f paas-caddy` e depois
   um deploy) com um certificado manual ativo: o Caddy deve subir já com os arquivos.

## Ficou em dúvida

- A documentação do Caddy não descreve um jeito de recomeçar a emissão de **um** nome só.
  O `--force` recomeça todos os nomes sem certificado. Isso é inofensivo para os válidos,
  mas manda mais pedidos ao Let's Encrypt se houver vários nomes quebrados.
- O tempo exato da renovação no certmagic depende da validade do certificado (cerca de
  1/3 do tempo restante) e, nas versões novas, da janela sugerida pelo emissor (ARI). Por
  isso a data mostrada é chamada de aproximada.
- Depois da primeira falha, o certmagic passa a tentar no ambiente de testes (staging) do
  Let's Encrypt. Não está confirmado na documentação se, depois do `reload --force`, a
  primeira tentativa volta direto à produção; pelo código, o contador de tentativas
  recomeça junto com o contexto novo.
