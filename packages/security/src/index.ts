/**
 * @paas/security — engine de scan de segurança + hardening.
 * Spec: docs/internal/security-research.md (checklist de 6 fases/30 passos).
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
  HOST_TIMEZONE_READ_CMD,
  PHASE_RUN_DIR_DEFAULT,
  PHASE_RUN_ID_RE,
  buildNsenterArgv,
  buildNsenterUploadArgv,
  buildPhaseFollowCommand,
  buildPhaseScriptCommand,
  buildSetTimezoneCommand,
  fixedReadOnlyCommands,
  isAllowedHostCommand,
  isPhaseFollowCommand,
  isSetTimezoneCommand,
  isValidPhaseRunId,
  parseHostTimezoneOutput,
  parsePhaseScriptCommand,
  type ParsedPhaseCommand,
  type PhaseCommandKind,
  type PhaseScriptCommandOptions,
} from "./host-bridge.js";
export {
  ACCESS_READ_ONLY_COMMANDS,
  buildChpasswdCommand,
  PASSWORD_WINDOW_COMMAND,
  parsePasswordWindow,
  FAIL2BAN_JAILS,
  FAIL2BAN_LIST_COMMAND,
  SSH_FACTS_COMMAND,
  blobForFingerprint,
  buildChpasswdInput,
  buildSshKeyAddCommand,
  buildSshKeyRemoveCommand,
  buildSshKeysListCommand,
  buildUnbanCommand,
  isAccessCommand,
  parseAuthorizedKeys,
  parseFail2banList,
  parseSshFacts,
  sshFingerprint,
} from "./host-access.js";
export {
  HostRunner,
  NsenterHostRunner,
  ContainerRunner,
  type ContainerRunnerOptions,
  type NsenterHostRunnerOptions,
  type ExecResult,
  type TargetRunner,
} from "./runner.js";
