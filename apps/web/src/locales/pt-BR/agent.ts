// Namespace "agent" (pt-BR): "Copiar instruções para o agente" — o texto que a pessoa cola na conversa
// com um agente de IA (Claude, Cursor, Copilot...) que está preparando o repositório para o painel.
// As regras seguem o guia "Preparar um projeto" (seção 8) e "Regras do compose" do site, e os guardrails
// de packages/deploy/src/rules.ts. Mudou uma regra lá, mude aqui (e no en).
export default {
  "copy.button": "Copiar instruções para o agente",
  "copy.copied": "Instruções copiadas",
  "copy.status": "Instruções copiadas. Cole na conversa com o seu agente de IA.",
  "copy.failed": "O navegador não deixou copiar sozinho. O texto está abaixo, já selecionado: copie com Ctrl+C (ou Cmd+C).",
  "copy.manualLabel": "Instruções para o agente de IA",
  "newProject.hint": "Vai preparar o projeto com um agente de IA (Claude, Cursor, Copilot)? Copie as instruções e cole na conversa, dentro da pasta do projeto: elas dizem o que o painel espera do repositório.",

  "text.intro": "Vou publicar este projeto no meu TWS Panel. Prepare o repositório para que o painel consiga publicá-lo, seguindo as regras abaixo.",
  "text.panel":
    "O que é o TWS Panel\n" +
    "- Um painel PaaS auto-hospedado numa VPS: roda cada projeto em containers Docker, com HTTPS automático por um Caddy central (o proxy do painel).\n" +
    "- Ele clona uma branch do repositório Git (ou usa uma pasta do servidor), detecta o tipo do projeto, confere o compose com regras de segurança (guardrails) e faz o deploy. Um bloqueio dos guardrails impede o deploy.\n" +
    "- Senhas, chaves e tokens são preenchidos na tela Variáveis do painel, que os grava num .env fora do repositório. Nenhum segredo vai no código.",
  "text.limits":
    "Limites deste trabalho\n" +
    "- Só altere arquivos do repositório. Não rode nada em servidor, não faça deploy e não leia nem mostre o conteúdo de arquivos .env.",
  "text.detect":
    "Como o painel decide o que fazer, na raiz do repositório, pela primeira regra que servir\n" +
    "1. Se existir compose.paas.yml, compose.prod.yml, compose.production.yml, docker-compose.prod.yml, compose.yml ou docker-compose.yml (nesta ordem), ele é adotado sem ser reescrito.\n" +
    "2. Dockerfile sem package.json: um container, na porta do EXPOSE do último estágio.\n" +
    "3. package.json: se houver Dockerfile, o Dockerfile tem prioridade. Sem Dockerfile: Next.js sem output \"export\" é Next.js com servidor (o painel gera o Dockerfile); com script \"build\", Vite, Next com output \"export\" ou uma pasta out/dist/build com index.html viram site estático (build no Node 22, servido por nginx).\n" +
    "4. index.html na raiz, sem build: site estático.\n" +
    "O tipo também pode ser escolhido à mão na tela de detecção do painel.",
  "text.rules":
    "Regras que o painel exige\n" +
    "- O app escuta em 0.0.0.0 (não em localhost), na porta declarada em EXPOSE (Dockerfile) ou expose (compose). O painel usa a primeira porta de expose; sem expose nem ports, o palpite é 80.\n" +
    "- Dockerfile: versão fixa na imagem base, processo sem root (USER; exceção: o Apache oficial do PHP, que atende como www-data), sem segredos em ENV ou ARG. Todo Dockerfile com \"COPY . .\" precisa de um .dockerignore que exclua .env, .git, node_modules e vendor.\n" +
    "- Não chame a imagem construída de node, nginx, alpine, caddy, stalwart, roundcube, tws-panel nem paas-*: use um nome seu.\n" +
    "- Com mais de um serviço, use compose.prod.yml. Não declare networks: a rede padrão do projeto já é interna e o painel liga sozinho o serviço do site ao proxy. Dê ao serviço do site um nome como web ou app.\n" +
    "- Use expose em vez de ports. NUNCA publique portas de banco (5432, 3306, 6379, 27017...), nem 80 ou 443.\n" +
    "- Dados em volumes nomeados, declarados no fim do arquivo, sem external, name nem driver. Nunca monte pastas do servidor fora do projeto, \"/\", /var/run nem o docker.sock.\n" +
    "- Proibido: privileged, cap_add, devices, network_mode: host, pid: host e ipc: host. Evite container_name e hostname. Nomes de serviço, volume e rede não podem começar com paas- nem tws-, e labels não podem começar com paas. nem com.docker.compose. (esses bloqueios não aceitam override).\n" +
    "- Bancos com healthcheck, e o app com depends_on condition: service_healthy. Migrações no command ou no entrypoint do app (por exemplo \"php artisan migrate --force\" ou \"npm run migrate\").\n" +
    "- Segredos NUNCA no arquivo: use ${VAR:?mensagem} para toda senha, chave e token. Usuário do banco diferente da senha (use app, não postgres nem admin). Nenhum valor como password, admin, root, 123456 ou changeme.\n" +
    "- Crie um .env.example com os nomes das variáveis e valores de mentira, e garanta .env no .gitignore.\n" +
    "- Imagens de terceiros com versão fixa (nada de :latest) e sem ferramentas de desenvolvimento (phpMyAdmin, Adminer, Mailhog, Mailpit) no arquivo de produção.\n" +
    "- Não use campos do compose fora do comum: o painel bloqueia campos que não conhece. No topo do arquivo, só name, services, networks, volumes, secrets, configs e campos x-.\n" +
    "- Contexto de build, Dockerfile, env_file e secrets ficam dentro do repositório.\n" +
    "- Build estático (Vite, Next export) só recebe as variáveis marcadas como \"de build\" no painel: VITE_* e NEXT_PUBLIC_* só com valores públicos, nunca segredo. Para SPA com rotas no navegador, avise-me para ligar \"Aplicação de página única\".\n" +
    "- Next.js com servidor e sem Dockerfile: coloque output: \"standalone\" no next.config e commite o lockfile.\n" +
    "- Laravel: compile os assets do Vite no Dockerfile e instale a extensão phpredis (ou use REDIS_CLIENT=predis).",
  "text.deliver":
    "O que entregar\n" +
    "- Os arquivos criados ou alterados.\n" +
    "- A lista das variáveis que preciso preencher na tela Variáveis do painel (só os nomes, com uma frase sobre o que cada uma é) e como gerar valores seguros (openssl rand -hex 24).\n" +
    "- O tipo de projeto que o painel deve detectar e a porta do serviço do site, para eu conferir na tela de detecção.\n" +
    "- Ao final, confira cada regra acima, item por item, e diga o que não foi possível cumprir.",
  "text.links":
    "Documentação do TWS Panel (consulte se tiver acesso à internet; se algo aqui divergir dela, vale a documentação)\n" +
    "- Como preparar um projeto: {prepareUrl}\n" +
    "- Regras do compose (o que barra o deploy e como corrigir): {composeRulesUrl}\n" +
    "- Instruções para agentes de IA: {agentPromptUrl}\n" +
    "- Documentação completa: {docsUrl}",
} as const;
