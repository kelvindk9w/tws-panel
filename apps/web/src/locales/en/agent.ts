// Namespace "agent" (en). Same keys as pt-BR/agent.ts; the rules follow the site's "Prepare your project"
// (section 8) and "Compose rules" guides and the guardrails in packages/deploy/src/rules.ts.
export default {
  "copy.button": "Copy instructions for your AI agent",
  "copy.copied": "Instructions copied",
  "copy.status": "Instructions copied. Paste them into the conversation with your AI agent.",
  "copy.failed": "The browser did not allow copying automatically. The text is below, already selected: copy it with Ctrl+C (or Cmd+C).",
  "copy.manualLabel": "Instructions for your AI agent",
  "newProject.hint": "Preparing the project with an AI agent (Claude, Cursor, Copilot)? Copy the instructions and paste them into the conversation, inside the project folder: they say what the panel expects from the repository.",

  "text.intro": "I am going to publish this project on my TWS Panel. Prepare the repository so the panel can publish it, following the rules below.",
  "text.panel":
    "What TWS Panel is\n" +
    "- A self-hosted PaaS panel on a VPS: it runs each project in Docker containers, with automatic HTTPS through a central Caddy (the panel's proxy).\n" +
    "- It clones one branch of the Git repository (or uses a folder on the server), detects the project type, checks the compose against security rules (guardrails) and deploys. A guardrail block stops the deploy.\n" +
    "- Passwords, keys and tokens are filled in on the panel's Variables screen, which writes them to a .env outside the repository. No secret goes into the code.",
  "text.limits":
    "Limits of this task\n" +
    "- Only change files in the repository. Do not run anything on a server, do not deploy, and do not read or show the contents of .env files.",
  "text.detect":
    "How the panel decides what to do, in the repository root, using the first rule that fits\n" +
    "1. If compose.paas.yml, compose.prod.yml, compose.production.yml, docker-compose.prod.yml, compose.yml or docker-compose.yml exists (in this order), it is adopted without being rewritten.\n" +
    "2. Dockerfile without package.json: one container, on the port from the EXPOSE of the last stage.\n" +
    "3. package.json: if a Dockerfile exists, the Dockerfile has priority. Without a Dockerfile: Next.js without output \"export\" is Next.js with a server (the panel generates the Dockerfile); with a \"build\" script, Vite, Next with output \"export\" or an out/dist/build folder with an index.html become a static site (built on Node 22, served by nginx).\n" +
    "4. index.html in the root, without a build: static site.\n" +
    "The type can also be chosen by hand on the panel's detection screen.",
  "text.rules":
    "Rules the panel requires\n" +
    "- The app listens on 0.0.0.0 (not localhost), on the port declared in EXPOSE (Dockerfile) or expose (compose). The panel uses the first expose port; with neither expose nor ports, the guess is 80.\n" +
    "- Dockerfile: pinned base image version, non-root process (USER; exception: the official PHP Apache image, which serves as www-data), no secrets in ENV or ARG. Every Dockerfile with \"COPY . .\" needs a .dockerignore that excludes .env, .git, node_modules and vendor.\n" +
    "- Do not name the built image node, nginx, alpine, caddy, stalwart, roundcube, tws-panel or paas-*: use a name of your own.\n" +
    "- With more than one service, use compose.prod.yml. Do not declare networks: the project's default network is already internal and the panel connects the site's service to the proxy by itself. Give the site's service a name such as web or app.\n" +
    "- Use expose instead of ports. NEVER publish database ports (5432, 3306, 6379, 27017...), nor 80 or 443.\n" +
    "- Data in named volumes, declared at the end of the file, without external, name or driver. Never mount server folders outside the project, \"/\", /var/run or the docker.sock.\n" +
    "- Forbidden: privileged, cap_add, devices, network_mode: host, pid: host and ipc: host. Avoid container_name and hostname. Service, volume and network names cannot start with paas- or tws-, and labels cannot start with paas. or com.docker.compose. (these blocks do not accept an override).\n" +
    "- Databases with a healthcheck, and the app with depends_on condition: service_healthy. Migrations in the app's command or entrypoint (for example \"php artisan migrate --force\" or \"npm run migrate\").\n" +
    "- Secrets NEVER in the file: use ${VAR:?message} for every password, key and token. Database user different from the password (use app, not postgres or admin). No values such as password, admin, root, 123456 or changeme.\n" +
    "- Create a .env.example with the variable names and fake values, and make sure .env is in .gitignore.\n" +
    "- Third-party images with a pinned version (no :latest) and no development tools (phpMyAdmin, Adminer, Mailhog, Mailpit) in the production file.\n" +
    "- Do not use unusual compose fields: the panel blocks fields it does not know. At the top of the file, only name, services, networks, volumes, secrets, configs and x- fields.\n" +
    "- Build context, Dockerfile, env_file and secrets stay inside the repository.\n" +
    "- Static builds (Vite, Next export) only receive the variables ticked \"build\" in the panel: VITE_* and NEXT_PUBLIC_* only with public values, never a secret. For a SPA with browser-side routes, tell me to turn on \"Single-page application\".\n" +
    "- Next.js with a server and no Dockerfile: set output: \"standalone\" in next.config and commit the lockfile.\n" +
    "- Laravel: build the Vite assets in the Dockerfile and install the phpredis extension (or use REDIS_CLIENT=predis).",
  "text.deliver":
    "What to deliver\n" +
    "- The files created or changed.\n" +
    "- The list of variables I must fill in on the panel's Variables screen (names only, with one sentence on what each is) and how to generate safe values (openssl rand -hex 24).\n" +
    "- The project type the panel should detect and the port of the site's service, so I can check it on the detection screen.\n" +
    "- At the end, check each rule above, item by item, and say what could not be met.",
  "text.links":
    "TWS Panel documentation (read it if you have internet access; if anything here differs from it, the documentation wins)\n" +
    "- How to prepare a project: {prepareUrl}\n" +
    "- Compose rules (what blocks the deploy and how to fix it): {composeRulesUrl}\n" +
    "- Instructions for AI agents: {agentPromptUrl}\n" +
    "- Full documentation: {docsUrl}",
} as const;
