/**
 * @paas/deploy — engine de deploy (Fase 2): detecção, ingestão, pipelines e
 * Caddy central. Orquestra Docker/Compose via CLI (ver engine.ts).
 */
export { detectProject } from "./detect.js";
export { analyzeCompose, guessProxyTarget } from "./guardrails.js";
export { runGuardrails, GUARDRAIL_RULES, type GuardrailRuleInfo } from "./rules.js";
export { ingestCode, projectSrcDir, projectWorkDir, type IngestContext } from "./ingest.js";
export { CaddyManager, renderCaddyfile, projectDomain, type CaddyTarget } from "./caddy.js";
export {
  DeployEngine,
  composeProjectName,
  containerPrefix,
  type EngineContext,
  type LogFn,
} from "./engine.js";
export { run, runStream, type ExecResult } from "./exec.js";
