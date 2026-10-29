/**
 * @paas/deploy — engine de deploy (Fase 2): detecção, ingestão, pipelines e
 * Caddy central. Orquestra Docker/Compose via CLI (ver engine.ts).
 */
export { detectProject, ForcedTypeError, looksLikeSpa, type DetectOptions } from "./detect.js";
export { buildVarProblem, selectBuildVars, type SelectedBuildVars } from "./build-vars.js";
export { describeComposeServices } from "./compose-services.js";
export { composeEnvFiles, composeServiceList, composeTimezoneDefinitions, timezoneServiceEnv, tzInDotenv } from "./compose-timezone.js";
export {
  addedPortKey,
  composeNetworkModes,
  composePortEntries,
  composeReplicas,
  effectiveServicePorts,
  networkModeBlock,
  portEntryText,
  type ComposePortEntry,
} from "./port-overrides.js";
export { analyzeCompose, guessProxyTarget } from "./guardrails.js";
export { runGuardrails, GUARDRAIL_RULES, type GuardrailRuleInfo, type IsolationContext } from "./rules.js";
export { HARD_RULES, checkComposeModel } from "./compose-model.js";
export { composeEnv, loadCanonicalCompose } from "./compose-config.js";
export { ingestCode, readDeployedCommit, pathsOverlap, projectSrcDir, projectWorkDir, reservedRoot, RESERVED_DIRNAME, type IngestContext } from "./ingest.js";
export { migrateLegacyWorkDir, removeProjectWorkDir, uploadOverlapBlocker, workDirRemovalBlocker } from "./workdir-safety.js";
export {
  CaddyManager,
  renderCaddyfile,
  projectDomain,
  manualCertificatePaths,
  type CaddyApplyOptions,
  type CaddyDynamic,
  type CaddyDynamicRoute,
  type CaddyMtaSts,
  type CaddyRedirect,
  type CaddyTarget,
  type CaddyWebmail,
  type ManualCaddyCertificate,
  type PanelSite,
} from "./caddy.js";
export { CADDY_CERTIFICATES_DIR, LIST_CERTIFICATES_SCRIPT, parseIssuedCertificates } from "./caddy-storage.js";
export { activePairs, explicitDomains, pairCandidates, type PairCandidate } from "./domain-pairs.js";
export {
  explainIssueError,
  parseCaddyCertificateLog,
  summarizeCaddyIssueFailures,
  ROUND_GAP_MS,
  sanitizeLogText,
  type CaddyIssueFailure,
  type CaddyCertEvent,
  type CaddyCertEventKind,
} from "./caddy-log.js";
export {
  DeployEngine,
  composeProjectName,
  containerPrefix,
  type DynamicDomainsInput,
  type EngineContext,
  type LogFn,
} from "./engine.js";
export { run, runStream, type ExecResult } from "./exec.js";
export { composeVariables, GENERATED_HEADER, missingFromComposeOutput, writeProjectDotenv, type ComposeVariable } from "./project-dotenv.js";
export { ENV_EXAMPLE_FILES, envExampleNames, readEnvExamples, type EnvExampleVariable } from "./env-example.js";
export { certificateStatus, type CertificateStatus } from "./tls-status.js";
export { checkGitAccess, remoteBranchCommit, type RemoteBranchCommit, classifyGitFailure, resolveTarget, isBlockedAddress, GIT_ACCESS_MESSAGES, type DnsLookup, type GitAccessInput, type TargetCheck } from "./git-access.js";
