/**
 * @paas/security — engine de scan de segurança + hardening.
 * Spec: docs/security-research.md (checklist de 6 fases/30 passos).
 */
export { SECURITY_CHECKS, type CheckDefinition, type CheckEvaluation } from "./checks.js";
export { runSecurityScan } from "./scanner.js";
export { buildSecurityPlan } from "./planner.js";
export { SecurityExecutor, type ExecutorOptions } from "./executor.js";
export { collectBaseline, diffBaseline, isDiffEmpty } from "./baseline.js";
export { MonitorScheduler, type MonitorSchedulerOptions } from "./monitor.js";
export {
  HostRunner,
  ContainerRunner,
  type ContainerRunnerOptions,
  type ExecResult,
  type TargetRunner,
} from "./runner.js";
