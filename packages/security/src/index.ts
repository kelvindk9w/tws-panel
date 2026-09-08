/**
 * @paas/security — engine de scan de segurança + hardening.
 * Spec: docs/security-research.md (checklist de 6 fases/30 passos).
 */
export { stripAnsi } from "./ansi.js";
export {
  SECURITY_CHECKS,
  parseSudoUsers,
  type CheckDefinition,
  type CheckEvaluation,
  type SudoUser,
} from "./checks.js";
export { runSecurityScan } from "./scanner.js";
export { buildSecurityPlan } from "./planner.js";
export { SecurityExecutor, type ExecutorOptions, type PhaseParams } from "./executor.js";
export { collectBaseline, diffBaseline, isDiffEmpty, BASELINE_COMMANDS } from "./baseline.js";
export { MonitorScheduler, type MonitorSchedulerOptions } from "./monitor.js";
export {
  CONTAINER_SKIP_REASON,
  partitionChecksForProfile,
  profileNote,
  type ProfilePartition,
} from "./profiles.js";
export {
  HOST_HELPER_IMAGE_DEFAULT,
  buildNsenterArgv,
  buildNsenterUploadArgv,
  buildPhaseScriptCommand,
  fixedReadOnlyCommands,
  isAllowedHostCommand,
  parsePhaseScriptCommand,
  type PhaseScriptCommandOptions,
} from "./host-bridge.js";
export {
  HostRunner,
  NsenterHostRunner,
  ContainerRunner,
  type ContainerRunnerOptions,
  type NsenterHostRunnerOptions,
  type ExecResult,
  type TargetRunner,
} from "./runner.js";
