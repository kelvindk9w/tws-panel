import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  CreateProjectRequest,
  SetAccountCredentialRequest,
  DeployJobListResponse,
  DeployJobResponse,
  DeployRequest,
  DetectRequest,
  DetectResponse,
  GuardrailReportResponse,
  Project,
  GitAccessCheckRequest,
  ProjectCredentialResponse,
  ProjectListResponse,
  ProjectResponse,
  ProjectUpdateStatusListResponse,
  ProjectUpdateStatusResponse,
  ProjectTimezoneRequest,
  SetPortRequest,
  SetPortsRequest,
  SetProjectCredentialRequest,
  UpdateProjectRequest,
} from "@paas/core";
import { CHOOSABLE_PROJECT_TYPES } from "@paas/core";
import { buildVarIssues } from "../services/project-env.js";
import { httpError, type HttpError } from "../services/deploy-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import { limitedProjectIds } from "../services/request-reach.js";
import { maskedForLimitedToken, maskPairOccupants, maskPortsResponse } from "../services/reach-masks.js";
import { attachStartups } from "../services/deploy-jobs.js";

// Schemas de validação. `additionalProperties: false` recusa campo desconhecido
// no corpo — impede que um cliente tente definir campos internos do projeto.
const INGEST_MODE = {
  type: "string",
  enum: ["git", "upload", "existing"],
} as const;

const createProjectSchema = {
  body: {
    type: "object",
    required: ["name", "ingestMode", "source", "domain"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      ingestMode: INGEST_MODE,
      source: { type: "string", minLength: 1, maxLength: 500 },
      branch: { type: "string", maxLength: 200 },
      domain: { type: "string", minLength: 1, maxLength: 253 },
      websocket: { type: "boolean" },
      proxyService: { type: ["string", "null"], maxLength: 100 },
      proxyPort: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
      backup: { type: "boolean" },
    },
  },
} as const;

// Params de projeto: o id é gerado pelo painel (hex de 16 chars). Validar o
// formato na borda evita que valor absurdo chegue às buscas e aos logs.
const projectIdParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const projectIdParamsSchema = { params: projectIdParams } as const;

const domainParams = {
  type: "object",
  required: ["id", "domain"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    domain: { type: "string", minLength: 1, maxLength: 253 },
  },
} as const;

const jobParamsSchema = {
  params: {
    type: "object",
    required: ["id", "jobId"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 64 },
      jobId: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

// deleteSource decide se o código-fonte é apagado do disco. Enum fechado: um
// valor ambíguo é recusado, nunca interpretado como false por omissão.
const deleteProjectSchema = {
  params: projectIdParams,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { deleteSource: { type: "string", enum: ["true", "false"] } },
  },
} as const;

// Corpo opcional: `POST /deploy` sem corpo é um deploy padrão (sem override),
// caso de uso legítimo de qualquer cliente de API — daí o "null" no type. Com
// corpo presente, o conteúdo é validado normalmente.
const deploySchema = {
  params: projectIdParams,
  body: {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      guardrailOverride: { type: "boolean" },
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
      emailCode: { type: "string", minLength: 1, maxLength: 16 },
      acceptedBlocks: { type: "array", maxItems: 200, items: { type: "string", maxLength: 800 } },
    },
  },
} as const;

const updateProjectSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
  },
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      source: { type: "string", minLength: 1, maxLength: 500 },
      branch: { type: "string", maxLength: 200 },
      domain: { type: "string", minLength: 1, maxLength: 253 },
      // false = sem o par com/sem www desse domínio (vale junto com `domain`)
      pair: { type: "boolean" },
      websocket: { type: "boolean" },
      // Anuláveis: a UI envia null para limpar o override (NewProjectPage).
      proxyService: { type: ["string", "null"], maxLength: 100 },
      proxyPort: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
      // aplicação de página única (site estático): fallback para o index.html
      spa: { type: "boolean" },
      // marca "projeto de desenvolvimento": só muda o padrão do backup antes de ações destrutivas na aba Banco
      development: { type: "boolean" },
    },
  },
} as const;

// Credencial de LEITURA do repositório privado. O token entra por aqui e
// NUNCA volta: as respostas só dizem que existe e mostram os 4 últimos
// caracteres. `additionalProperties: false` impede um cliente de tentar
// pedir escopo/permissão extra — o painel só lê repositórios.
const setCredentialSchema = {
  params: projectIdParams,
  body: {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1, maxLength: 500 },
      username: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
} as const;

// "Testar acesso" do assistente Novo projeto. O token vem no corpo e NUNCA volta,
// nem vai para a auditoria ou o log; nada é gravado (consulta somente leitura).
const checkGitAccessSchema = {
  body: {
    type: "object",
    required: ["source"],
    additionalProperties: false,
    properties: {
      source: { type: "string", minLength: 1, maxLength: 500 },
      branch: { type: "string", maxLength: 200 },
      token: { type: "string", minLength: 1, maxLength: 500 },
      useAccount: { type: "boolean" },
    },
  },
} as const;

// Troca da porta do SERVIDOR (modal Portas). Só 1024–65535 (abaixo é do
// sistema; 80/443 são do painel) e só os dois endereços que o painel oferece:
// 127.0.0.1 (só no servidor) ou 0.0.0.0 (todos). A porta interna não entra.
const setPortSchema = {
  params: projectIdParams,
  body: {
    type: "object",
    required: ["service", "original", "action"],
    additionalProperties: false,
    properties: {
      service: { type: "string", minLength: 1, maxLength: 100 },
      original: { type: "string", minLength: 1, maxLength: 200 },
      action: { type: "string", enum: ["change", "remove", "reset"] },
      hostPort: { type: "integer", minimum: 1024, maximum: 65535 },
      hostIp: { type: "string", enum: ["127.0.0.1", "0.0.0.0"] },
    },
  },
} as const;

// Edição em lote (e "Publicar uma porta"): a lista COMPLETA de publicações do
// projeto. Com `original`, é uma porta do compose (hostPort null = remover);
// sem, é uma publicação adicionada (porta interna 1–65535). O servidor confere
// as linhas juntas (conflito entre si e com o resto do servidor).
const setPortsSchema = {
  params: projectIdParams,
  body: {
    type: "object",
    required: ["ports"],
    additionalProperties: false,
    properties: {
      ports: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          required: ["service", "hostPort"],
          additionalProperties: false,
          properties: {
            service: { type: "string", minLength: 1, maxLength: 100 },
            original: { type: "string", minLength: 1, maxLength: 200 },
            containerPort: { type: "integer", minimum: 1, maximum: 65535 },
            protocol: { type: "string", enum: ["tcp", "udp"] },
            hostPort: { type: ["integer", "null"], minimum: 1024, maximum: 65535 },
            hostIp: { type: "string", enum: ["127.0.0.1", "0.0.0.0"] },
          },
        },
      },
    },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  // Token limitado a projetos: recusa de conflito (domínio, porta, nome) nunca revela o que há fora do alcance.
  const e = maskedForLimitedToken(reply.request, err) as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
    // relatório de guardrails quando o deploy é bloqueado (Fase 4)
    ...(e.report ? { report: e.report } : {}),
    ...(e.missing ? { missing: e.missing } : {}),
    // erros de cada linha na edição de portas em lote
    ...(e.details ?? {}),
  });
}

/**
 * Falha de gravação do cofre (ver persist() em services/credential-vault.ts).
 * A mensagem genérica do store não diz o que ficou valendo — cada rota troca
 * pela do contexto, sem detalhe do sistema de arquivos.
 */
function isStorageWriteFailure(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "storage_write_failed";
}

const projectsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  // DeployService compartilhado (decorado no escopo raiz em app.ts).
  const service = app.deployService;

  /** Parar/iniciar pelo painel faz o container "começar de novo": o monitoramento não conta isso como reinício sem parar. */
  async function noteManualAction(idOrSlug: string): Promise<void> {
    if (!app.hasDecorator("metrics")) return;
    const project = await service.getProject(idOrSlug).catch(() => null);
    if (project) app.metrics.collector.noteManualAction(project.slug);
  }

  /**
   * Monta a resposta de um projeto. Centralizado de propósito: a informação de
   * credencial é sempre a versão pública (existe? dica?), nunca o valor — e um
   * único lugar de montagem é o que garante isso em TODAS as rotas.
   */
  async function projectResponse(
    project: Project,
    containers?: Awaited<ReturnType<typeof service.listContainers>>,
  ): Promise<ProjectResponse> {
    const { status, containers: mine } = await service.statusOf(project, containers);
    return {
      project,
      status,
      containers: mine,
      url: service.projectUrl(project),
      credential: await service.credentialInfo(project),
    };
  }

  /**
   * Projeto criado por token limitado: registra na lista do token. Devolve null se deu certo, ou o
   * corpo do erro. Se não registrar, desfaz o projeto; se nem isso der, o erro diz claramente que
   * o projeto existe FORA do alcance do token (e não pode ser alcançado por ele).
   */
  async function registerCreatedProject(project: Project, tokenId: string): Promise<{ error: string; message: string } | null> {
    let registered = false;
    try {
      registered = await app.apiTokens.addProject(tokenId, project.id);
    } catch (err) {
      app.log.error({ err }, "não foi possível registrar o projeto na lista do token");
    }
    if (registered) return null;
    try {
      await service.deleteProject(project.id, false, () => undefined);
      if (app.hasDecorator("backupService")) await app.backupService.forgetProject(project.id).catch(() => undefined);
    } catch (err) {
      app.log.error({ err }, "projeto criado por token não pôde ser desfeito");
      return {
        error: "project_created_unregistered",
        message: `O projeto "${project.slug}" foi criado, mas não entrou na lista do token e não foi possível desfazer. Ele está fora do alcance do token: apague-o pelo painel.`,
      };
    }
    return {
      error: "project_not_registered",
      message: "Não foi possível registrar o projeto novo na lista do token. O projeto foi desfeito: nada foi criado.",
    };
  }

  // Lista projetos + status calculado a partir dos containers.
  app.get("/api/projects", async (request, reply) => {
    const containers = await service.listContainers();
    const limit = limitedProjectIds(request);
    const projects = (await service.listProjects()).filter((p) => limit === null || limit.has(p.id));
    const responses: ProjectResponse[] = [];
    for (const project of projects) {
      responses.push(await projectResponse(project, containers));
    }
    const response: ProjectListResponse = { projects: responses };
    return reply.send(response);
  });

  // Cria projeto.
  app.post<{ Body: CreateProjectRequest }>(
    "/api/projects",
    { schema: createProjectSchema },
    async (request, reply) => {
      try {
        const { backup, ...req } = request.body ?? ({} as CreateProjectRequest);
        const creator = request.session?.token;
        const project = await service.createProject(req, { byLimitedToken: creator?.reach.kind === "projects" });
        // Token com "pode criar projetos": o projeto novo entra na lista do token ANTES de qualquer
        // outra coisa. Se não der para registrar, o projeto é desfeito (nunca fica um projeto criado
        // por token e fora do limite dele sem aviso).
        if (creator && creator.reach.kind === "projects") {
          const failure = await registerCreatedProject(project, creator.id);
          if (failure) return reply.code(500).send(failure);
          await app.auditService.record({
            action: "project.create",
            target: project.slug,
            detail: `Projeto "${project.name}" criado pelo token e registrado na lista dele.`,
          });
        }
        // "Fazer backup: sim/não" da criação; sem a escolha, vale o "Padrão dos
        // projetos". O serviço de backups fica no escopo raiz (app.ts);
        // instalações de teste podem não tê-lo.
        if (app.hasDecorator("backupService")) await app.backupService.initProject(project.id, backup);
        return reply.code(201).send(await projectResponse(project));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Detalhe de um projeto.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const project = await service.getProject(request.params.id);
      if (!project) {
        return reply
          .code(404)
          .send({
            error: "project_not_found",
            message: "Projeto não encontrado.",
          });
      }
      return reply.send(await projectResponse(project));
    },
  );

  // Alerta de "nova atualização": SÓ AVISO (nunca faz deploy). O cliente não escolhe URL nem branch:
  // o servidor consulta o repositório e a branch já cadastrados no projeto. A resposta traz códigos
  // fixos e commits curtos, nunca texto do git nem credencial.
  app.get("/api/projects/update-status", async (request, reply) => {
    try {
      const limit = limitedProjectIds(request);
      const statuses = (await service.updateStatuses()).filter((st) => limit === null || limit.has(st.projectId));
      const response: ProjectUpdateStatusListResponse = { statuses };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/update-status",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        const response: ProjectUpdateStatusResponse = { status: await service.updateStatus(request.params.id) };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // "Verificar agora": força nova consulta (limite por projeto, para o botão não virar martelo no servidor remoto).
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/update-status/check",
    {
      // sem corpo: o cliente não escolhe endereço nem branch (campo extra é recusado)
      schema: { params: projectIdParams, body: { type: ["object", "null"], additionalProperties: false, properties: {} } },
      config: {
        rateLimit: {
          max: 6,
          timeWindow: "1 minute",
          keyGenerator: (request: { ip: string; params: unknown }) =>
            `${request.ip}:${(request.params as { id?: string }).id ?? ""}`,
        },
      },
    },
    async (request, reply) => {
      try {
        const response: ProjectUpdateStatusResponse = {
          status: await service.updateStatus(request.params.id, { force: true }),
        };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Seção Variáveis: variáveis de ambiente do projeto (valem no próximo deploy).
  app.get<{ Params: { id: string } }>("/api/projects/:id/env", { schema: projectIdParamsSchema }, async (request, reply) => {
    try {
      const [vars, compose, provided, providedValues, links, example, mailTest, proxy] = await Promise.all([
        service.getEnv(request.params.id),
        service.composeVariablesFor(request.params.id),
        service.providedEnvKeys(request.params.id),
        // valores do que o painel fornece, para o olho da tela — sem a senha da caixa
        service.providedEnvValues(request.params.id),
        // ligadas ao e-mail (SMTP_SENHA ← SMTP_PASS) e nomes do .env.example: só nomes
        service.envLinkSources(request.params.id),
        service.envExampleFor(request.params.id),
        // caixa de teste de e-mail ligada: host e variáveis que o painel redireciona (null = desligada)
        service.mailTestInfo(request.params.id),
        // cartão "Rede e proxy": IP/sub-rede do Caddy na paas-net (vai junto das variáveis: nenhum token lê esta rota)
        service.proxyInfo(request.params.id),
      ]);
      return reply.send({ vars, compose, provided, providedValues, links, example, mailTest, proxy });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Olho da seção Variáveis: valor de UMA variável fornecida pelo painel
  // (e-mail do projeto e ligadas), senha da caixa inclusive. A listagem acima
  // nunca traz a senha; aqui ela só sai a pedido, com Auditoria (só o nome) e
  // limite de frequência no serviço (decisão do dono do produto, 04/10/2026).
  app.get<{ Params: { id: string; name: string } }>(
    "/api/projects/:id/env/provided/:name",
    {
      schema: {
        params: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const value = await service.revealProvidedEnv(request.params.id, request.params.name);
        return reply.header("cache-control", "no-store").send({ name: request.params.name, value });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { vars: Array<{ key: string; value: string; build?: boolean }> } }>(
    "/api/projects/:id/env",
    {
      schema: {
        params: projectIdParams,
        body: {
          type: "object",
          required: ["vars"],
          additionalProperties: false,
          properties: {
            vars: {
              type: "array",
              // sem minItems (lista vazia vale) e sem maxItems: o teto (ENV_MAX_VARS) é checado no serviço, com mensagem clara
              items: {
                type: "object",
                required: ["key", "value"],
                additionalProperties: false,
                properties: {
                  key: { type: "string", minLength: 1, maxLength: 128 },
                  value: { type: "string", maxLength: 32768 },
                  // "de build": pública, vai ao build (estático e docker build)
                  build: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const vars = await service.setEnv(request.params.id, request.body.vars);
        // Salvar nunca é barrado por falta de obrigatória nem por marca "de build" que o build não aceita: o dado foi
        // gravado e a resposta traz os avisos (só nomes). A recusa de verdade fica no deploy.
        // Os avisos são um extra: se o cálculo falhar, a gravação já aconteceu, então responde sucesso sem eles.
        let missing: string[] = [];
        let buildIssues: Array<{ name: string; reason: string }> = [];
        try {
          missing = await service.missingEnvFor(request.params.id);
          buildIssues = buildVarIssues(vars);
        } catch {
          request.log.warn("variáveis salvas, mas não foi possível calcular os avisos");
        }
        return reply.send({ vars, missing, buildIssues });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // "Testar acesso": git ls-remote com o token digitado (ou o da conta do GitHub).
  // Responde 200 também quando o teste falha (ok:false + motivo): o pedido foi
  // válido, o resultado é que não foi bom. Nada é gravado nem auditado.
  app.post<{ Body: GitAccessCheckRequest }>(
    "/api/projects/check-git-access",
    { schema: checkGitAccessSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        return reply.send(await service.checkGitAccess(request.body));
      } catch (err) {
        // Sem a mensagem do erro: ela poderia ecoar o que o git recebeu (o token).
        const e = err as Partial<HttpError>;
        if (e.statusCode) return sendError(reply, err);
        request.log.error("falha inesperada ao testar o acesso ao repositório");
        return reply.code(500).send({ error: "git_access_failed", message: "Não foi possível testar o acesso agora." });
      }
    },
  );

  // Seção Git: o repositório é público? (esconde o bloco de token quando é)
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/repo-visibility",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const project = await service.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      const visibility = project.ingestMode === "git" ? await service.github.repoVisibility(project.source) : "unknown";
      return reply.send({ visibility });
    },
  );

  // Visão geral: o certificado HTTPS de cada domínio está válido? (quem emitiu, até quando)
  app.get<{ Params: { id: string } }>("/api/projects/:id/https", { schema: projectIdParamsSchema }, async (request, reply) => {
    try {
      return reply.send({ domains: await service.httpsStatus(request.params.id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Domínios do projeto: o principal + quantos adicionais o operador quiser.
  // Publicado, a mudança vale na hora (Caddy recarregado pelo serviço).
  app.post<{ Params: { id: string }; Body: { domain: string; pair?: boolean } }>(
    "/api/projects/:id/domains",
    {
      schema: {
        params: projectIdParams,
        body: {
          type: "object",
          required: ["domain"],
          additionalProperties: false,
          properties: {
            domain: { type: "string", minLength: 1, maxLength: 253 },
            // false = sem o par com/sem www desse domínio
            pair: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { domain, pair } = request.body;
        const added =
          pair === undefined ? await service.addDomain(request.params.id, domain) : await service.addDomain(request.params.id, domain, { pair });
        return reply.send(await projectResponse(added));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; domain: string } }>(
    "/api/projects/:id/domains/:domain",
    { schema: { params: domainParams } },
    async (request, reply) => {
      try {
        return reply.send(await projectResponse(await service.removeDomain(request.params.id, request.params.domain)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string; domain: string }; Body: { port: number | null } }>(
    "/api/projects/:id/domains/:domain/port",
    {
      schema: {
        params: domainParams,
        body: {
          type: "object",
          required: ["port"],
          additionalProperties: false,
          properties: { port: { type: ["integer", "null"], minimum: 1, maximum: 65535 } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await projectResponse(await service.setDomainPort(request.params.id, request.params.domain, request.body.port)),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // O par (com/sem www) de cada domínio do projeto e a situação dele agora.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/domains/pairs",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        return reply.send({ pairs: maskPairOccupants(request, await service.domainPairs(request.params.id)) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Liga ou desliga o par de um domínio; vale na hora.
  app.put<{ Params: { id: string; domain: string }; Body: { enabled: boolean } }>(
    "/api/projects/:id/domains/:domain/pair",
    {
      schema: {
        params: domainParams,
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await projectResponse(await service.setDomainPair(request.params.id, request.params.domain, request.body.enabled)),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; domain: string } }>(
    "/api/projects/:id/domains/:domain/primary",
    { schema: { params: domainParams } },
    async (request, reply) => {
      try {
        return reply.send(
          await projectResponse(await service.setPrimaryDomain(request.params.id, request.params.domain)),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Portas (modal "Portas"): somente leitura, sem segredos — o que está no ar
  // (docker ps, uma listagem por consulta) e o que cada projeto vai publicar.
  app.get("/api/ports", async (_request, reply) => {
    try {
      return reply.send(await service.portsOverview());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/ports", { schema: projectIdParamsSchema }, async (request, reply) => {
    try {
      return reply.send(maskPortsResponse(request, await service.projectPorts(request.params.id)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Troca a porta do servidor (vale no próximo deploy; registrada na auditoria).
  app.put<{ Params: { id: string }; Body: SetPortRequest }>(
    "/api/projects/:id/ports",
    { schema: setPortSchema },
    async (request, reply) => {
      try {
        return reply.send(maskPortsResponse(request, await service.setPort(request.params.id, request.body)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Edição em lote: a lista completa numa chamada (auditoria project.ports_batch).
  app.put<{ Params: { id: string }; Body: SetPortsRequest }>(
    "/api/projects/:id/ports/batch",
    { schema: setPortsSchema },
    async (request, reply) => {
      try {
        return reply.send(maskPortsResponse(request, await service.setPorts(request.params.id, request.body)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Atualiza domínio/flags antes do próximo deploy.
  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    "/api/projects/:id",
    { schema: updateProjectSchema },
    async (request, reply) => {
      try {
        const project = await service.updateProject(
          request.params.id,
          request.body ?? {},
        );
        return reply.send(await projectResponse(project));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Define/substitui a credencial de LEITURA do repositório privado.
  //
  // O corpo carrega o token, mas a resposta e a auditoria carregam apenas o
  // FATO: existe uma credencial, cadastrada agora, terminada em XXXX. O valor
  // vive só no cofre cifrado (services/credential-vault.ts) e no ambiente do
  // processo git durante o clone.
  app.put<{ Params: { id: string }; Body: SetProjectCredentialRequest }>(
    "/api/projects/:id/credential",
    { schema: setCredentialSchema },
    async (request, reply) => {
      try {
        const credential = await service.setCredential(request.params.id, request.body);
        await app.auditService.record({
          action: "project.credential.set",
          target: request.params.id,
          detail:
            `Credencial de LEITURA do repositório definida (usuário "${credential.username ?? "-"}", ` +
            `token terminado em ${credential.hint ?? "????"}). O valor não é registrado.`,
        });
        const response: ProjectCredentialResponse = { credential };
        return reply.send(response);
      } catch (err) {
        if (isStorageWriteFailure(err)) {
          request.log.error({ err }, "falha ao gravar a credencial no cofre");
          return sendError(reply, {
            statusCode: 500,
            code: "storage_write_failed",
            message:
              "Não foi possível salvar a credencial no servidor. Nada foi alterado: a credencial " +
              "anterior (se havia uma) continua valendo.",
          });
        }
        return sendError(reply, err);
      }
    },
  );

  // Remove a credencial de leitura do projeto.
  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/credential",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        const havia = await service.removeCredential(request.params.id);
        await app.auditService.record({
          action: "project.credential.remove",
          target: request.params.id,
          detail: havia
            ? "Credencial de LEITURA do repositório removida do cofre."
            : "Remoção de credencial solicitada, mas o projeto não tinha nenhuma cadastrada.",
        });
        return reply.send({
          ok: true,
          credential: { configured: false, hint: null, username: null, updatedAt: null },
        });
      } catch (err) {
        if (isStorageWriteFailure(err)) {
          request.log.error({ err }, "falha ao gravar a remoção da credencial no cofre");
          return sendError(reply, {
            statusCode: 500,
            code: "storage_write_failed",
            message:
              "Não foi possível remover a credencial no servidor. Nada foi alterado: a credencial " +
              "continua cadastrada.",
          });
        }
        return sendError(reply, err);
      }
    },
  );

  // Projeto criado por token limitado não usa a conta GitHub conectada. SÓ a pessoa libera (senha e, com
  // 2FA, o código: liberar AUMENTA o acesso); voltar a bloquear não pede nada.
  app.put<{ Params: { id: string }; Body: SetAccountCredentialRequest }>(
    "/api/projects/:id/account-credential",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: projectIdParams,
        body: {
          type: "object",
          required: ["allow"],
          additionalProperties: false,
          properties: {
            allow: { type: "boolean" },
            currentPassword: { type: "string", minLength: 1, maxLength: 512 },
            code: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const project = await service.getProject(request.params.id);
        if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
        const allow = request.body.allow;
        let actor = request.session?.username;
        let attempt: { success(): void; release(): void } | null = null;
        if (allow) {
          const confirmed = await confirmIdentity(app, request, reply, request.body);
          if (!confirmed) return reply;
          attempt = confirmed.attempt;
          actor = confirmed.user.username;
        }
        try {
          const updated = await service.setAccountCredential(project.id, allow);
          attempt?.success();
          await app.auditService.record({
            actor,
            action: "project.account_credential",
            target: updated.slug,
            detail: allow
              ? "Conta GitHub conectada liberada para o clone deste projeto (criado por token limitado)."
              : "Conta GitHub conectada bloqueada para o clone deste projeto.",
          });
          return reply.send(await projectResponse(updated));
        } finally {
          attempt?.release();
        }
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Detecção automática de tipo + guardrails.
  // Corpo opcional: { type } = tipo escolhido à mão (null = voltar ao automático).
  app.post<{ Params: { id: string }; Body: DetectRequest | null | undefined }>(
    "/api/projects/:id/detect",
    {
      schema: {
        params: projectIdParams,
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { type: { type: ["string", "null"], enum: [...CHOOSABLE_PROJECT_TYPES, null] } },
        },
      },
    },
    async (request, reply) => {
      try {
        const detection = await service.detect(request.params.id, request.body?.type !== undefined ? { type: request.body.type } : {});
        const response: DetectResponse = { detection };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Relatório de guardrails sob demanda (Fase 4) — exibido antes do deploy.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/guardrails",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      try {
        const { report, note } = await service.guardrailsForProject(
          request.params.id,
        );
        const response: GuardrailReportResponse = { report, note };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Inicia deploy (job assíncrono). Body opcional: { guardrailOverride: true }
  // para confirmar explicitamente o override de bloqueios de guardrail (Fase 4).
  //
  // O override libera container privilegiado, namespaces do host e montagem de pastas do servidor: na prática,
  // root na VPS. Por isso exige a MESMA prova de habilitar o terminal (senha + 2FA + código por e-mail quando
  // ligado, ação "deploy.override"), só vale para sessão humana (token nunca) e avisa o dono por e-mail.
  // Deploy sem override não pede nada, e NADA herda um override anterior: reinício, redeploy automático e a
  // restauração do banco chamam startDeploy sem override (continuam bloqueados se o compose ainda tiver bloqueios).
  app.post<{ Params: { id: string }; Body: DeployRequest }>(
    "/api/projects/:id/deploy",
    { schema: deploySchema },
    async (request, reply) => {
      const override = request.body?.guardrailOverride === true;
      if (!override) {
        try {
          const job = await service.startDeploy(request.params.id, { guardrailOverride: false });
          const response: DeployJobResponse = { job };
          return reply.code(202).send(response);
        } catch (err) {
          return sendError(reply, err);
        }
      }
      if (request.session?.token) {
        return reply.code(403).send({ error: "token_forbidden", message: "Liberar os bloqueios de segurança do deploy só pela pessoa, no painel." });
      }
      const body = request.body!;
      // O override vale só para os bloqueios que a pessoa viu na tela: sem a lista não há o que aceitar
      // (conferido antes da reautenticação, para não gastar o código à toa).
      if (!Array.isArray(body.acceptedBlocks)) {
        return reply.code(400).send({
          error: "accepted_blocks_required",
          message: "Revise os bloqueios na tela e aceite-os de novo: o override só vale para os bloqueios que você viu.",
        });
      }
      const acceptedBlocks = body.acceptedBlocks;
      const confirmed = await confirmIdentity(
        app,
        request,
        reply,
        { currentPassword: body.currentPassword, code: body.code, emailCode: body.emailCode },
        { requireTwoFactor: true, emailCode: "if-enabled", action: "deploy.override" },
      );
      if (!confirmed) return reply;
      try {
        const job = await service.startDeploy(request.params.id, { guardrailOverride: true, acceptedBlocks });
        const alertWarning = await app.emailCode.alertAccessChange(
          confirmed.user,
          `deploy do projeto ${request.params.id} com os bloqueios de segurança liberados (pode dar acesso de administrador à VPS)`,
          request.ip,
        );
        confirmed.attempt.success();
        const response: DeployJobResponse = { job, ...(alertWarning ? { alertWarning } : {}) };
        return reply.code(202).send(response);
      } catch (err) {
        return sendError(reply, err);
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  // Status + log de um job de deploy.
  app.get<{ Params: { id: string; jobId: string } }>(
    "/api/projects/:id/jobs/:jobId",
    { schema: jobParamsSchema },
    async (request, reply) => {
      const job = await service.getJob(request.params.id, request.params.jobId);
      if (!job) {
        return reply
          .code(404)
          .send({ error: "job_not_found", message: "Job não encontrado." });
      }
      // tempo de subida dos serviços neste deploy, medido pelo monitoramento (quando está ligado)
      const owner = app.hasDecorator("metrics") ? await service.getProject(request.params.id) : null;
      const withStartups = owner ? attachStartups([job], app.metrics.startups.list(owner.slug, 40), Date.now())[0]! : job;
      const response: DeployJobResponse = { job: withStartups };
      return reply.send(response);
    },
  );

  // Histórico de deploys do projeto. Mesmo contrato 404 das demais rotas
  // :id — sem isso, projeto inexistente devolvia 200 com lista vazia,
  // indistinguível de "projeto existe mas nunca teve deploy".
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/jobs",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const project = await service.getProject(request.params.id);
      if (!project) {
        return reply
          .code(404)
          .send({
            error: "project_not_found",
            message: "Projeto não encontrado.",
          });
      }
      const listed = await service.listJobs(request.params.id);
      // tempo de subida de cada serviço, medido pelo monitoramento (quando ele está ligado)
      const jobs = app.hasDecorator("metrics") ? attachStartups(listed, app.metrics.startups.list(project.slug, 40), Date.now()) : listed;
      const response: DeployJobListResponse = { jobs };
      return reply.send(response);
    },
  );

  // Fuso horário do projeto: a escolha, o que está nos containers, quem já
  // define TZ e se a imagem tem a base de fusos (docker exec).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/timezone",
    { schema: projectIdParamsSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        return reply.send(await service.timezoneView(request.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: ProjectTimezoneRequest }>(
    "/api/projects/:id/timezone",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        params: projectIdParams,
        body: {
          type: "object",
          required: ["mode"],
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["image", "host", "zone"] },
            zone: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await service.setProjectTimezone(request.params.id, request.body, request.session?.username);
        return reply.send(await service.timezoneView(request.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // "Reiniciar com o fuso novo": recria os containers com a configuração
  // atual, sem baixar código nem refazer o build (job, como o deploy).
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/recreate",
    { schema: projectIdParamsSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const job = await service.startRecreate(request.params.id, request.session?.username);
        const response: DeployJobResponse = { job };
        return reply.code(202).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Para a stack do projeto.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/stop",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const log: string[] = [];
      try {
        await noteManualAction(request.params.id);
        await service.stop(request.params.id, (chunk) => log.push(chunk));
        return reply.send({ ok: true, log: log.join("") });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Sobe a stack do projeto.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/start",
    { schema: projectIdParamsSchema },
    async (request, reply) => {
      const log: string[] = [];
      try {
        await noteManualAction(request.params.id);
        await service.start(request.params.id, (chunk) => log.push(chunk));
        return reply.send({ ok: true, log: log.join("") });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Remove projeto (containers + domínio; código opcional via ?deleteSource=true).
  app.delete<{
    Params: { id: string };
    Querystring: { deleteSource?: string };
  }>("/api/projects/:id", { schema: deleteProjectSchema }, async (request, reply) => {
    const log: string[] = [];
    try {
      const existing = await service.getProject(request.params.id);
      // Bancos temporários do teste de restauração que este projeto recebeu: apagados antes de o container sumir.
      if (existing && app.hasDecorator("backupService")) await app.backupService.beforeDeleteProject(existing.id).catch(() => undefined);
      await service.deleteProject(
        request.params.id,
        request.query.deleteSource === "true",
        (chunk) => log.push(chunk),
      );
      // Os tempos de subida medidos do projeto saem com ele (um slug reaproveitado não herda os do antigo).
      if (existing && app.hasDecorator("metrics")) await app.metrics.startups.forget(existing.slug);
      // Os arquivos de backup ficam (na VPS e fora); só a configuração sai.
      if (existing && app.hasDecorator("backupService")) await app.backupService.forgetProject(existing.id);
      // Os domínios dinâmicos (nomes e sufixos) saem com o projeto.
      if (existing && app.hasDecorator("dynamicDomains")) await app.dynamicDomains.forgetProject(existing.id).catch((err: unknown) => app.log.error({ err }, "domínios dinâmicos do projeto apagado não puderam ser limpos (o ask já nega o projeto inexistente)"));
      // Projeto apagado sai da lista de todos os tokens (um id nunca é reaproveitado, mas a lista não guarda lixo).
      if (existing && app.hasDecorator("apiTokens")) {
        try {
          await app.apiTokens.forgetProject(existing.id);
        } catch (err) {
          // Não é silencioso: o projeto já foi apagado, mas o id ficou nas listas dos tokens. O acesso nunca passa
          // para um projeto novo (o plugin de autenticação exige o id exato), e a pessoa fica sabendo.
          request.log.error({ err }, "não foi possível tirar o projeto apagado das listas dos tokens");
          await app.auditService.record({
            action: "project.delete",
            target: existing.slug,
            detail: "Projeto apagado, mas o id ficou nas listas de tokens de API (falha ao gravar). Ele não alcança nenhum outro projeto.",
          });
          return reply.code(500).send({
            error: "token_lists_not_updated",
            message: "O projeto foi apagado, mas não foi possível tirá-lo das listas dos tokens de API. Edite o alcance dos tokens em Configurações → Acesso por IA.",
          });
        }
      }
      return reply.send({ ok: true, log: log.join("") });
    } catch (err) {
      return sendError(reply, err);
    }
  });
};

export default projectsRoutes;
