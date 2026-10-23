# Plano: conectar uma IA ao TWS Panel (MCP)

Este documento descreve, em linguagem simples, como o TWS Panel poderá ser operado por um assistente de IA (como o Claude) de forma segura. Ele resume a análise técnica feita antes e termina com as decisões que precisam da aprovação do Kelvin.

## 1. O que é isso, em poucas palavras

**MCP** é um padrão que permite a uma IA usar "ferramentas" de um programa. Em vez de a pessoa copiar e colar telas, comandos e erros no chat, a IA consulta o painel diretamente: vê o estado dos projetos, confere o DNS, lê o resultado de um deploy e, com permissão, faz mudanças.

A ideia é que a IA ajude a pessoa a "deixar o painel pronto" desde o primeiro acesso, sem que ela precise entender de servidor.

**Princípio central:** a IA nunca tem mais poder do que a pessoa deu, nunca vê senhas e nunca executa algo perigoso sem que um humano aprove dentro do painel.

## 2. Situação atual (o que já existe e o que falta)

- O painel só conhece dois tipos de acesso: o **cookie de sessão** (quem fez login) e o **setup token** (a chave temporária do assistente de instalação). Não existe um "token de API" com escopo, validade e revogação.
- Enquanto o assistente de instalação não termina, o setup token vale para todas as rotas da API. Isso permite um MCP bem cedo, sem criar nada novo, mas só para consulta.
- Várias partes do código assumem que há uma sessão de login (cerca de 38 lugares). Um token de API precisa se passar por uma "sessão compatível", senão essas rotas quebram. Esse é o maior custo técnico do projeto.
- A proteção contra requisições vindas de outros sites (CSRF) deixa passar clientes que não são navegador, como um servidor MCP. Por isso o MCP não precisa de configuração de CORS.
- A auditoria já aceita registrar "quem fez". Dá para gravar algo como "mcp:nome-do-token" em cada ação feita pela IA.
- Algumas rotas devolvem segredos (senha de caixa de e-mail, senha de backup, valores de variáveis). Elas ficam **fora** do MCP.

## 3. Como a IA se conecta

- **Transporte escolhido:** HTTP "streamable" no próprio painel, no endereço `/mcp`. Assim a IA conversa com o painel por HTTPS, com uma versão só do código, sem instalar nada extra no computador da pessoa.
- Na primeira versão, o `/mcp` é uma camada fina que reaproveita as rotas que o painel já tem. Com isso herda validação, auditoria e controle de escopo.
- O `/mcp` só aceita token (Bearer), **nunca cookie**, e rejeita requisições vindas de navegador (proteção contra um tipo de ataque chamado DNS rebinding).
- Fica **desligado por padrão**. A pessoa liga em Configurações (ou o instalador liga, se ela pedir).
- Conferir se o proxy (Caddy) mantém o envio contínuo de dados (`flush_interval -1`) também para `/mcp`.
- Um programa pequeno de linha de comando (stdio) e uma especificação OpenAPI ficam para depois.

### Como o token é criado sem colar segredo no chat

- **Durante a instalação:** a pessoa usa o setup token que o instalador já mostra, guardado numa variável de ambiente no terminal dela. A IA nunca lê o valor.
- **No primeiro acesso, depois de criar o administrador:** um botão **"Conectar uma IA"** gera um token de 24 horas, copia o comando de conexão para a área de transferência e não mostra o segredo na conversa.
- **Mais adiante:** pareamento. A IA mostra um código curto, a pessoa aprova no painel e o token vai direto para o programa da IA, sem copiar e colar.

## 4. Fases de entrega

Cada fase só entra com testes que mantenham a cobertura mínima exigida pelo CI do servidor.

### Fase 0: fundação (tokens de API com escopo)

- Novo cadastro de tokens, no mesmo estilo do armazenamento de sessões: arquivo protegido, gravação segura, só o hash do token fica guardado.
- Cada token tem nome, escopo (leitura, escrita ou administração), validade, último uso e data de revogação.
- O `plugins/auth.ts` passa a aceitar `Authorization: Bearer`, criando uma "sessão sintética" compatível com o código existente.
- Auditoria registra quem agiu (`token:<nome>`).
- Telas e rotas para criar, listar e revogar tokens, **só com sessão humana** (e 2FA, se estiver ativo). Um token nunca cria nem revoga outro token.
- Tamanho: médio.

### Fase 1: MVP somente leitura

- O `/mcp` no próprio painel com as ferramentas de consulta: estado do painel e roteiro "Deixe o painel pronto", saúde e versão, projetos, domínios e portas, nomes das variáveis (sem valores), deploys e logs, e-mail (sem senhas), backups, certificados, notificações, varredura de segurança, alertas, auditoria e containers.
- Durante a instalação, o setup token pode ser aceito em `/mcp` apenas com o conjunto mínimo: roteiro de onboarding, plano de segurança, saúde e checagem de DNS.
- Saída sempre em formato estruturado, com textos livres tratados como dado, truncados e com segredos removidos.
- Tela em Configurações, "Acesso por IA".
- Tamanho: médio.

### Fase 2: mudanças reversíveis e botão "Conectar uma IA"

- Ferramentas de escrita que dá para desfazer: criar e ajustar projetos, definir variáveis (sem nunca devolver o valor), domínios e portas, deploy, parar, reiniciar e iniciar, configurar notificações, criar domínio e caixa de e-mail, agendar e rodar backup, fuso horário.
- Onde existir, modo de simulação (`dryRun`) como padrão.
- Senhas geradas vão direto para o cofre ou para as variáveis do projeto. A IA nunca as vê.
- Botão **"Conectar uma IA"** no fim do primeiro acesso, com token de 24 horas.
- Limites de frequência por token.
- Tamanho: médio a grande.

### Fase 3: confirmação humana para ações destrutivas

- Para ações perigosas (apagar projeto, domínio, caixa de e-mail ou certificado, restaurar backup, trocar o domínio do painel), o servidor responde "confirmação necessária" com um código de uso único, válido por 5 minutos.
- A ação só acontece depois que a pessoa aprova na tela do painel (área "Pendências de IA"), com 2FA se estiver ativo. A IA não consegue aprovar sozinha.
- Opcional nesta fase: linha de conexão impressa pelo instalador (válida só enquanto o setup token existir) e o programa stdio.
- Tamanho: grande.

### Fase 4: pareamento e OpenAPI

- Pareamento por código curto (a pessoa aprova no painel e o token é entregue direto ao cliente de IA).
- Especificação OpenAPI pública, aproveitando o inventário de ferramentas já feito.
- Tamanho: grande.

## 5. As 8 decisões (com recomendação e motivo)

| # | Pergunta | Recomendação | Motivo |
|---|---|---|---|
| 1 | O MCP vem ligado ou desligado? | **Desligado por padrão**, com opção explícita no fim do assistente de instalação. | Quem não pediu não ganha uma porta nova exposta na internet. |
| 2 | Aceitar o setup token em `/mcp` durante a instalação? | **Sim, só para leitura** e diagnóstico, com poucas ferramentas. | O token já é impresso pelo instalador e some quando o administrador é criado. Dá ajuda desde o minuto zero sem criar nada novo. |
| 3 | A IA pode aplicar de verdade as mudanças de segurança (SSH, firewall)? | **Só simulação (`dryRun`).** A aplicação real exige aprovação na tela do painel. | Um erro pode trancar o próprio dono do servidor para fora. |
| 4 | Como entram segredos novos (senha de caixa, token do GitHub, chave de backup)? | **Nunca passam pela IA.** O servidor gera o valor, ou a IA só abre a tela certa para a pessoa digitar. | Tudo o que passa pela IA pode ficar em histórico de conversa e logs. |
| 5 | Quais escopos de permissão? | **Três níveis:** leitura, escrita e administração. Escopo por módulo só se houver pedido. | É simples de explicar e de testar. Mais granularidade traz complexidade antes da hora. |
| 6 | Como confirmar ações destrutivas? | **Pela tela do painel, com 2FA quando estiver ativo.** | É o mesmo modelo que já protege o reinício do assistente de instalação. É o único freio real contra uma IA enganada por texto malicioso. |
| 7 | Qual a validade do token? | **24 horas** para o criado pelo assistente de instalação e **30 dias** (máximo 1 ano) para os criados em Configurações. | Token curto reduz o estrago se vazar. Quem usa no dia a dia precisa de algo mais duradouro. |
| 8 | Entram já o programa stdio e o OpenAPI? | **Depois.** Primeiro o HTTP estável e auditado. | Evita manter três caminhos de acesso ao mesmo tempo antes de o principal estar maduro. |

## 6. Riscos e como reduzi-los

- **Injeção de instruções por texto** (nomes de projeto, logs, variáveis e mensagens de commit chegam à IA e podem tentar "mandar" nela). Mitigação: saída estruturada, textos marcados como dado não confiável, truncados e sem formatação; descrição das ferramentas dizendo que o conteúdo é dado e não instrução; e, principalmente, confirmação humana nas ações de risco.
- **Vazamento de segredo.** Mitigação: nenhuma ferramenta devolve senha, token ou chave; valores de variáveis aparecem mascarados; a lista de campos sensíveis do log vale também para as respostas.
- **Token roubado.** Mitigação: só o hash fica no disco, validade curta, revogação imediata, limite de tentativas errôneas e de frequência, registro de último uso.
- **Quebrar o que já funciona** (as rotas que dependem de sessão). Mitigação: sessão sintética compatível e testes de regressão dos usos de sessão.
- **Nova superfície exposta na internet.** Mitigação: desligado por padrão, só token, sem cookie, rejeição de requisições de navegador, limite de frequência.
- **Cortar o acesso do dono** (firewall, SSH, domínio do painel). Mitigação: simulação por padrão e aprovação humana para a aplicação real.
- **Prazo.** O trabalho mexe no coração da autenticação. Por isso a fase 0 é a mais cuidadosa e vem com muitos testes (falha de disco, arquivo corrompido, token expirado, rota proibida).

### O que fica fora do MCP, sem exceção

- Terminal web (executa comandos como administrador do servidor).
- Reinício do assistente de instalação.
- Troca de senha e de 2FA.
- Revelar a senha dos backups.
- Ver credenciais de caixas de e-mail e senhas fornecidas ao projeto.
- Ler valores de variáveis.
- Tokens do GitHub e chaves de serviços externos.
- Criar ou revogar tokens de API.

## 7. Documentação a entregar junto

- Pasta `comoFuncionaSistema/`: novo módulo de acesso por IA, atualização dos documentos de autenticação, auditoria e modelo de ameaças, e do índice.
- Um relatório por fase.
- Site: página "Conectar um assistente de IA (MCP)" em inglês e em português, com exemplos genéricos, sem endereços, domínios ou tokens reais.
- `ROADMAP.md`, `CHANGELOG.md`, `SECURITY.md` (política do token) e um parágrafo nos READMEs.

## 8. Ordem em relação aos outros lotes

1. Primeiro, o **PR #102**.
2. Depois, o **lote de travas do login**.
3. Só então o **MCP** (fase 0 em diante).

Motivo: o MCP mexe em `plugins/auth.ts`, o mesmo arquivo que o PR #102 e as travas do login alteram. Fazer tudo ao mesmo tempo geraria conflitos e arriscaria a segurança do login. Começando depois dos dois, o MCP parte de uma base de autenticação já revisada e estável.

## 9. Próximo passo

Kelvin aprova ou ajusta as 8 decisões da seção 5. Com isso, a fase 0 pode ser detalhada em tarefas e começar assim que o PR #102 e o lote de travas do login estiverem integrados.

## 10. Atualização (decisões do Kelvin depois da Fase 0)

1. **Objetivo ampliado:** a IA deve poder instalar, configurar e publicar, não só consultar. Ela pode conectar cedo (inclusive durante o assistente de instalação) e, com o mínimo de orientação, colocar um projeto no ar.
2. **Quanto a IA pode gerenciar é decisão de quem conecta.** Cada token define o alcance:
   - **Painel inteiro** (nível de leitura, escrita ou administração, como na Fase 0); ou
   - **Só os projetos escolhidos**, com o mesmo nível; e, opcionalmente,
   - **Pode criar projetos novos:** o projeto criado pela IA entra sozinho na lista do token, para ela configurar e publicar sem sair do limite.
3. **Token limitado a projetos nunca alcança o que é do painel ou do servidor:** domínio do painel, caixas e domínios de e-mail do servidor, backups e restauração do painel, segurança do servidor, usuários, notificações globais e outros tokens. Esses ficam só com token de painel inteiro.
4. **Entra antes da Fase 1** como "Fase 0b: escopo por projeto", porque o `/mcp` já precisa nascer respeitando esse limite. A Fase 1 passa a ser a "fatia vertical projeto no ar".
5. **Segredos:** caminho seguro por padrão (a IA lista o que falta; a pessoa digita os valores sensíveis na tela). Ler `.env` local só por opção explícita.
6. **Ações destrutivas** continuam exigindo aprovação humana na tela, com 2FA, mesmo com token de administração.
