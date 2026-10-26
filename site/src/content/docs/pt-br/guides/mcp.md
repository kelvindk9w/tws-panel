---
title: "Conectar um assistente de IA (MCP)"
description: "Como ligar o MCP do painel, criar o token, conectar um cliente (Claude Code e outros), o que cada ferramenta faz, as quatro opções de poder (segurança, segredos, aprovação humana, métricas) e como aprovar ações sensíveis."
sidebar:
  label: "Assistente de IA (MCP)"
---

O **MCP** (Model Context Protocol) é a forma padrão de um assistente de IA usar ferramentas. Com ele ligado, o
assistente consulta e opera o painel pelo mesmo caminho da tela: cria um projeto, define variáveis, faz deploy,
lê logs. Quem decide **quanto poder** ele tem é você, na hora de criar o token.

> [!NOTE]
> O MCP já vem **desligado**. Enquanto estiver desligado, o endereço `/mcp` responde como se não existisse.
> Só o transporte HTTP está no painel. Cliente por terminal (stdio) e OpenAPI ficam para depois.

## 1. Ligar

1. Abra **Configurações → Acesso por IA**.
2. No cartão **Acesso por IA (MCP)**, informe a sua senha (e o código, se tiver verificação em duas etapas) e
   clique em **Ligar o acesso por IA**.
3. O endereço aparece na tela, no formato `https://painel.example.com/mcp`. Para desligar, o botão fica ao lado
   e não pede senha.

## 2. Criar o token

Na mesma tela, crie um token (veja [Acesso por IA](./ai-access.md)). Para o MCP, escolha:

- **Nível**: leitura (só consulta), escrita (consulta e opera projetos que já existem) ou administração
  (também cria projeto e cadastra domínio). O token **nunca** apaga nada pelo MCP, qualquer que seja o nível.
- **Alcance**: o painel inteiro ou só alguns projetos. Fora do alcance o projeto simplesmente não existe para o
  assistente (o mesmo 404 de um projeto que não existe).
- **Validade**: 1, 7, 15, 30 (padrão), 90, 180 ou 365 dias, ou **sem vencimento**. Sem vencimento pede a sua
  confirmação, porque um token que vazar vale para sempre até você revogá-lo.
- **Opções de IA**, todas desligadas por padrão (veja a seção 4).

O valor do token aparece uma única vez. Guarde-o.

## 3. Conectar um cliente

Qualquer cliente MCP com transporte HTTP serve. Exemplo para o Claude Code:

```bash
claude mcp add --transport http tws-panel https://painel.example.com/mcp \
  --header "Authorization: Bearer <seu-token>"
```

O token vai sempre no cabeçalho `Authorization`. Cookie de sessão não vale no `/mcp`, e token na URL é recusado. Token errado, vencido ou ausente recebe `401` **sem** o cabeçalho `WWW-Authenticate`: de propósito, para o cliente não procurar um login OAuth que o painel não tem e mostrar o erro real.

## O que o assistente pode fazer

| Ferramenta | O que faz | Nível mínimo |
|---|---|---|
| `get_access_info` | diz o que este token alcança e quais opções tem ligadas | leitura |
| `list_projects`, `get_project`, `get_project_guardrails` | consulta projetos e as travas de segurança | leitura |
| `list_deploys`, `get_deploy`, `get_logs` | histórico de deploys e logs | leitura |
| `get_project_https`, `check_dns` | situação do HTTPS e do DNS | leitura |
| `list_env_names` | nomes das variáveis, sem valor | leitura |
| `get_env_value` | valor de uma variável (só com a opção "Ler segredos") | leitura |
| `get_approval` | situação de um pedido de aprovação | leitura |
| `read_panel_info` | informações do painel (só token de painel inteiro) | leitura |
| `create_project` | cria um projeto a partir de um repositório Git | administração |
| `update_project` | altera configurações do projeto; trocar domínio, branch, par www ou proxy pede aprovação | escrita (administração para domínio, branch e proxy) |
| `set_env_vars` | cria variáveis novas; trocar ou esvaziar uma que já existe pede aprovação; nunca apaga | escrita |
| `add_domain` | cadastra um domínio no projeto | administração |
| `deploy_project`, `restart_project` | publica e reinicia | escrita |
| `recreate_project` | recria os containers (sensível, pede aprovação) | escrita |
| `security_plan`, `get_security_job` | monta o plano de endurecimento a partir da última verificação (não muda nada) e acompanha o trabalho de segurança | administração |
| `security_apply` | simulação por padrão; aplicar de verdade é uma opção | administração |

Não existe ferramenta que apague projeto, variável, domínio, backup ou token. As ferramentas de projeto, domínio,
deploy e segurança chamam as mesmas rotas da tela, com as mesmas validações, travas e limites de taxa. As de variáveis são a
exceção: a rota da tela mostra valores e por isso nenhum token a usa; elas conferem alcance e nível por conta própria e
usam o mesmo serviço.

**Auditoria.** O que muda algo, os pedidos de aprovação e a leitura de um segredo entram na **Auditoria** sempre, com o nome
do token e o nome do cliente. Consultas e recusas repetidas entram no máximo uma vez por minuto por token e ferramenta (com a
contagem das repetidas), e abrir sessão, uma vez por hora por token: assim uma IA ocupada não enche a Auditoria. O arquivo
antigo da Auditoria tem teto de 20 mil entradas.

**Limite de taxa.** O `/mcp` tem um limite próprio de 120 chamadas por minuto por token. As chamadas que as ferramentas fazem
às rotas contam num balde por token, não no IP de quem usa a tela do painel.

## 4. As opções de poder

Quem instala decide quanto poder a IA tem. Cada opção é do **token**, nasce desligada e só se liga com a sua
senha (desligar não pede senha e vale na hora). Ao ligar, a tela mostra o risco.

| Opção | Desligada (padrão) | Ligada |
|---|---|---|
| **Aplicar segurança** | `security_apply` só simula (dry-run). | Pode aplicar de verdade SSH e firewall. Um erro pode trancar você para fora do servidor. |
| **Ler segredos** | A IA cria variáveis novas e vê só os nomes; o valor vem mascarado. Trocar um valor que já existe (inclusive as variáveis que o painel fornece, como `SMTP_*`), ou gravar um nome que executa código ou redireciona a rede (`NODE_*`, `BASH_ENV`, `PYTHON*`, `LD_*`, `JAVA_TOOL_OPTIONS`, `GIT_*`, `COMPOSE_*`, `PATH`, `HTTP_PROXY` e qualquer `*_PROXY`, `SSL_CERT_*`, `JAVA_OPTS`, `PIP_*`, `COMPOSER_*`...), pede a sua aprovação. Para esses nomes a tela mostra o valor que a IA escreveu. | `get_env_value` devolve o valor. Ele pode ficar no histórico da conversa da IA. |
| **Dispensar aprovação** | Recriar projeto, mudar domínio, branch, par www ou proxy, trocar variável existente e aplicar segurança esperam a sua aprovação na tela. | A IA faz sozinha, sem você ver antes. |
| **Métricas** | A IA não vê consumo. | `get_metrics_summary` e `get_project_metrics`; `get_host_metrics` (VPS inteira) só se o token tiver alcance de painel ou de monitoramento. |

> [!CAUTION]
> **"Ler segredos" desligada não é uma garantia absoluta.** Um token de escrita pode criar variáveis, publicar e ler os
> logs. Se o código que roda no projeto é da própria IA (por exemplo, um projeto criado a partir de um repositório dela por
> um token de administração), esse código pode imprimir o ambiente. Por isso o painel pede a sua aprovação para os nomes que
> executam código e mascara nos logs os valores das variáveis (também em base64 e hexadecimal), mas isso é melhor esforço:
> um app que escreve o segredo de outro jeito passa. Só dê escrita e criação de projetos a uma IA em que você confia para
> publicar código.

## 5. Aprovar uma ação sensível

Quando a IA pede algo sensível e o token **não** dispensa a aprovação, a chamada volta com
`approval_required` e um número de pedido. Então:

1. O pedido aparece em **Configurações → Acesso por IA → Pedidos de aprovação**, com o nome do **token** em destaque, o projeto e o que ela quer fazer (de variáveis, só os nomes). O nome do programa da IA é informado por ela mesma e não prova nada: confie no nome do token.
2. Clique em **Aprovar**, informe a senha (e o código) e confirme. Ou **Recusar**.
3. A IA repete a mesma chamada com o número do pedido.

O pedido vale por 10 minutos, serve para **uma** execução, está preso àquele token e àqueles argumentos, e some
se o painel reiniciar ou se você desligar o MCP. Cada token tem no máximo 5 pedidos esperando (e 20 sessões abertas), então
um token comprometido não enche a fila dos outros. Um token não consegue aprovar nada, nem um de administração.

## Instalando agora (opcional)

Para que uma IA ajude a **instalar** o painel antes de existir uma conta, defina `PAAS_MCP_SETUP_LEVEL` com `read`, `write`
ou `admin` no arquivo `.env` do painel (o `docker-compose.yml` repassa a variável ao container) e recrie o container. É uma
escolha explícita de quem instala o servidor:

- durante a instalação, uma **credencial derivada** do token de setup vale no `/mcp` com esse nível, **mesmo com o MCP
  desligado** na tela (ainda não há conta para ligá-lo). Entregue à IA **só essa credencial**, nunca o token de setup: ela
  não abre nenhuma rota da API (nem o assistente que cria a conta) e o token de setup cru não vale no `/mcp`. O painel a
  grava em `/data/mcp-setup-credential` (0600); leia com `sudo docker exec tws-panel cat /data/mcp-setup-credential`. Só o
  cabeçalho `Authorization: Bearer <credencial>` vale;
- não há aprovação humana nesse modo, então as ações sensíveis (recriar, mudar domínio, trocar variável existente, aplicar
  segurança) são recusadas;
- quando a instalação termina, o token de setup **deixa de valer** e o MCP volta a seguir a chave da tela, que começa
  **desligada**. A tela de conclusão da instalação oferece ligá-la (com a sua senha).

Remova a variável do `.env` depois da instalação.

## Limitações

- O endereço precisa chegar ao painel pelo Caddy, por HTTPS. As respostas são JSON simples; não há stream.
- Pedidos de aprovação e sessões MCP ficam na memória e somem ao reiniciar o painel.
- O painel guarda o nome do cliente enviado pelo próprio cliente; ele serve para a Auditoria, não para segurança. A tela de aprovação o mostra como "informado pela IA".
