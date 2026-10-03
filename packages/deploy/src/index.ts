/**
 * @paas/deploy — engine de deploy (Fase 2): detecção, ingestão, pipelines e
 * Caddy central. Orquestra Docker/Compose via CLI (ver engine.ts).
 */
export { detectProject } from "./detect.js";
export { analyzeCompose, guessProxyTarget } from "./guardrails.js";
export { runGuardrails, GUARDRAIL_RULES, type GuardrailRuleInfo } from "./rules.js";
export { ingestCode, projectSrcDir, projectWorkDir, type IngestContext } from "./ingest.js";
export {
  CaddyManager,
  renderCaddyfile,
  projectDomain,
  manualCertificatePaths,
  type CaddyApplyOptions,
  type CaddyTarget,
  type ManualCaddyCertificate,
  type PanelSite,
} from "./caddy.js";
export {
  explainIssueError,
  parseCaddyCertificateLog,
  sanitizeLogText,
  type CaddyCertEvent,
  type CaddyCertEventKind,
} from "./caddy-log.js";
export {
  DeployEngine,
  composeProjectName,
  containerPrefix,
  type EngineContext,
  type LogFn,
} from "./engine.js";
export { run, runStream, type ExecResult } from "./exec.js";
export { composeVariables, missingFromComposeOutput, writeProjectDotenv, type ComposeVariable } from "./project-dotenv.js";
export { ENV_EXAMPLE_FILES, envExampleNames, readEnvExamples, type EnvExampleVariable } from "./env-example.js";
export { certificateStatus, type CertificateStatus } from "./tls-status.js";
