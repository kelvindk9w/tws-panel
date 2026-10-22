# Relatório — aviso de variável de host e "Testar acesso" do repositório privado

Duas coisas validadas na prática pelo dono.

## Item 1 — aviso de `://` em variável de host

### O problema
O dono salvou `SITE_HOST=http://…` e `CARTEIRA_HOST=https://…`. O compose do projeto esperava só o nome do host, o Caddy do projeto montou `http://http://…` e a tela ficou em branco, sem nenhuma pista.

### O que mudou (pelo comportamento)
- Na seção Variáveis, a linha de uma variável de host com valor estranho ganha um aviso âmbar em português: o que está estranho (esquema, barra ou caminho, porta, espaço), o valor sugerido (só o nome do domínio) e o botão **Corrigir**, que troca o valor na lista. O valor corrigido só é gravado ao salvar.
- O aviso **não bloqueia** o salvar. Editar o valor reavalia na hora.
- Na importação de `.env`, as linhas importadas aparecem com o mesmo aviso e o resumo da importação diz quantas variáveis de host têm valor estranho.
- No deploy (projetos compose e Dockerfile), o log ganha uma linha `⚠ Aviso: a variável X tem …` por variável estranha. O deploy segue.
- Variáveis `*_URL*` não são afetadas.

### A regra (packages/core/src/env-hosts.ts)
- **Nome:** termina em `HOST`, `HOSTNAME` ou `DOMAIN` (com ou sem prefixo, qualquer caixa). `DOCKER_HOST` fica de fora (o `unix://`/`tcp://` faz parte do valor dele). `PGHOST`, `ALLOWED_HOSTS`, `DOMAINS` não entram.
- **Valor estranho:** esquema (`://`), barra, caminho, `?` ou `#`, porta (`host:587`, `[::1]:25`) ou espaço (inclusive nas pontas).
- **Decisão sobre porta:** `MAIL_HOST=mail.exemplo.com:587` **avisa**, porque a convenção é a porta ir em `*_PORT`. Se o app lê `host:porta` de propósito, o aviso é só ignorado (não bloqueia).
- **Não avisa:** valor vazio, socket unix (começa com `/`), interpolação (`$`), lista com vírgula, IPv6 sem colchetes (`::1`).
- **Segredo:** nome com cara de segredo (a mesma regex da pesquisa da tela, agora no core) ou valor com `usuario:senha@` na frente: nem o valor nem a sugestão são mostrados (tela e log). O log nunca traz o valor salvo; só a sugestão, que é apenas o host.

## Item 2 — botão "Testar acesso" (repositório privado)

### O problema
O token era guardado e o erro só aparecia no clone, depois de criar o projeto.

### O que mudou (pelo comportamento)
- Rota nova `POST /api/projects/check-git-access` (ver `projetos/testar-acesso-repositorio.json`): sessão obrigatória, escrita de outro site recusada (CSRF), 10 consultas por minuto. Com a URL, a branch opcional e o token digitado (ou `useAccount` para o da conta do GitHub), faz um `git ls-remote` somente leitura e responde em português: acesso confirmado (branch padrão e lista curta de branches), token inválido ou expirado, repositório pede autenticação, sem permissão de leitura, repositório não encontrado (ou token que não o enxerga), branch inexistente (com as que existem), protocolo não suportado, servidor inacessível, tempo esgotado.
- Assistente Novo projeto: botão **Testar acesso** ao lado do campo do token e também depois de escolher da lista um repositório privado da conta do GitHub. Estados carregando/ok/erro numa região `role="status"`; textos em pt-BR e en; o resultado antigo some quando URL, branch ou token mudam; o texto quebra palavras longas (sem estouro em 360/390 px).
- Não cria o projeto, não grava nada, não audita.

### Segurança do token
- Chega ao git só por variável de ambiente, lida por um credential helper em linha (o mesmo do clone, agora compartilhado em `git-safe.ts`). Não há arquivo temporário para apagar, o argv não tem o valor e a URL não leva `usuario:senha`.
- Mesmas validações da criação (`validateGitSource`, `validateBranch`); `ext::` barrado; o endereço vai depois de `--`; `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` vazio, hooks/fsmonitor desligados, `cwd` fora de qualquer repositório.
- A resposta só tem motivo, mensagem fixa e listas de branches. Só o motivo "desconhecido" leva a última linha do git, antes limpa do token e do `usuario:senha` da URL. Erro inesperado da rota devolve mensagem fixa (a do erro poderia ecoar o token).
- Teste de `ps` real: enquanto o git roda contra um servidor que não responde, nenhuma linha de comando do sistema contém o token.
- **O token fica no ambiente do processo git enquanto ele roda** (no máximo 15 s), então é legível em `/proc/<pid>/environ` por quem roda como o mesmo usuário do sistema. Não está no argv, em arquivo, em log nem em resposta.

## Revisão (correções do 566eacd)
- **Prazo real e processos órfãos.** A consulta agora roda em grupo de processos próprio e o grupo inteiro leva SIGKILL aos 15 s TOTAIS (inclusive com servidor que goteja bytes) e ao fim normal. Antes, só o `git` de cima morria (execFile) e os `remote-http`/`ssh` ficavam vivos com o token no ambiente. O ssh ganhou `ServerAliveInterval`/`ServerAliveCountMax`. Testes: servidor que goteja e ssh mudo respondem em ~2 s (prazo de teste) e nenhum processo sobra.
- **Redirecionamento (revisões 2 e 3).** O clone/fetch REAL segue redirecionamentos, com ou sem token; `http.followRedirects=false` não está no `GIT_SAFE_CONFIG` nem é usado na ingestão (quebraria repositório público sem token e GitLab privado cadastrado sem `.git`, que responde 301). O token é protegido pelo credential helper, que só responde quando o `host=` pedido pelo git é o host[:porta] do endereço cadastrado: redirecionamento no mesmo host funciona com token; para outro host o token não é enviado (o segundo servidor não recebe `Authorization`) e a mensagem em português diz que o token só vai ao host do projeto e que se use o endereço final. Testes de efeito em `ingest-credencial.test.ts` (301 público sem token; 301 no mesmo host com token; 302 para outro host). O TESTE DE ACESSO nunca segue redirecionamento, com ou sem token, e diz `redirected`: senão um host público poderia redirecionar a consulta para loopback/metadados/rede interna e contornar a lista de destinos bloqueados (SSRF por redirect). Teste: A responde 302 para B (loopback) sem token, B não recebe requisição e o resultado é `redirected`.
- **Alcance de rede.** O teste recusa loopback, 0.0.0.0, link-local (metadados 169.254.0.0/16), `localhost` e nomes que resolvem para isso (basta um endereço), com mensagem em português. Para https, o nome é resolvido uma vez e os endereços conferidos são fixados no curl (`http.curloptResolve`), contra rebinding; em ssh só o nome resolvido é conferido (limitação). Redes privadas (10/8, 172.16/12, 192.168/16) seguem permitidas por causa de Git interno legítimo: nelas a rota ainda é um oráculo (a resposta diferencia inacessível, tempo esgotado, não encontrado, e lista branches), contido por sessão obrigatória, 10 consultas/min e mensagens fixas.
- **Proxy.** O teste remove `http_proxy`/`https_proxy`/`all_proxy` do ambiente e zera `http.proxy`: um proxy herdado faria a conexão por conta própria e contornaria a fixação do DNS. Consequência: o teste não passa por proxy corporativo; o clone do deploy não mudou.
- **Rede privada inclui 172.17.0.1** (ponte do Docker, que leva ao próprio host e a serviços que só escutam nele): continua permitida e entra no oráculo descrito acima.
- **Pendência registrada:** a mesma recusa NÃO foi aplicada ao clone/fetch real. Instalações de desenvolvimento podem apontar para um Git em localhost; aplicar lá é decisão do dono.
- **Token não verificado.** Com token em repositório público o git nunca o pede. O helper do teste marca no stderr quando é chamado; a resposta traz `tokenUsed` e a tela avisa "o token não foi verificado".
- **Interface.** O botão usa `aria-disabled` durante a consulta (o foco não se perde), a dica fica empilhada abaixo do botão (sem coluna estreita em 360 px). Anotado: o estouro de 13 a 22 px a 360 px vem do indicador de passos do assistente, que já existia antes e não foi alterado.

## Decisão registrada
GitHub responde 404 tanto para repositório inexistente quanto para privado que o token não enxerga. O painel não consegue distinguir; com token informado, o motivo é `not_found_or_no_access` e a mensagem diz as duas possibilidades.

## Testes
- core: `env-hosts.test.ts`. deploy: `git-access.test.ts` (servidor HTTP falso: token certo, 401, 403, 404, público, sem resposta, porta fechada), `engine-aviso-host.test.ts`. server: `deploy-git-access.test.ts`, `routes-projects-git-access.test.ts`. web: `env-host-warning.test.tsx`, `git-access-test.test.tsx`.
- Cobertura: números na resposta final da execução.

## Não testado
- Contra o GitHub/GitLab reais: a classificação usa as mensagens conhecidas do git e o servidor falso reproduz os códigos HTTP. Vale uma conferência com um token de verdade (válido, expirado, fine-grained sem o repositório).
- Clone por ssh (o teste só confere que roda sem prompt e falha como "inacessível" numa porta fechada).
- Layout visual em 360/390 px em navegador real (garantido por classes de quebra e `flex-wrap`, verificadas em teste; sem captura de tela).
