import type {
  AgentProviderStatusDto,
  AgentProviderStatusListDto,
} from '@/lib/managed-agent-runtime/provider-status'
import {
  readAgentUpdateStatus,
  type UpdateCheckOptions,
} from '../update-system'
import { probeHermesProfileGateway } from './hermes-gateway-probe'

/**
 * Project Hermes Agent update-system status into the same provider-status row
 * shape the Runtimes table already renders. Auth/readiness comes from a
 * lightweight gateway probe (default profile); install/upgrade capability is
 * driven by `readAgentUpdateStatus`.
 */
export async function hermesProviderStatusRow(
  options?: UpdateCheckOptions,
): Promise<AgentProviderStatusDto> {
  // Provider status is a readiness snapshot — never git-fetch here. Remote
  // tips are refreshed only by `/api/update/status` (daily / manual).
  const update = readAgentUpdateStatus({
    fetch: options?.fetch ?? 'local',
    refresh: options?.refresh,
  })
  let registered = false
  try {
    const probe = await probeHermesProfileGateway('default')
    registered = probe.available
  } catch {
    registered = false
  }
  const installed = Boolean(update.path) || update.installKind === 'git'
  return {
    provider: 'hermes',
    targetId: 'runtime:hermes',
    registered,
    installed,
    binaryPath: update.path,
    version: update.version !== 'unknown' ? update.version : null,
    latestVersion: update.latestHead
      ? update.latestHead.slice(0, 7)
      : null,
    updateAvailable: update.updateAvailable,
    auth: {
      status: registered ? 'authenticated' : 'required',
      accountLabel: update.branch,
      authMethod: 'gateway',
    },
    install: {
      kind: update.installKind,
      displayCommand: 'Settings → Runtimes → Hermes Agent → 升级',
      packageName: 'hermes-agent',
      binaryName: 'hermes',
      managedNpm: false,
    },
    update: {
      capability: update.canUpdate ? 'supported' : 'unsupported',
      source: 'git',
      currentVersion: update.version !== 'unknown' ? update.version : null,
      latestVersion: update.latestHead
        ? update.latestHead.slice(0, 7)
        : null,
      lastCheckedAt: new Date().toISOString(),
      reasonCode:
        update.state === 'error'
          ? 'hermes_update_check_failed'
          : update.canUpdate || !update.updateAvailable
            ? null
            : update.reason
              ? 'hermes_update_blocked'
              : null,
      ...(update.canUpdate
        ? {}
        : {
            unsupportedReason:
              update.reason ?? 'Hermes Agent update is not one-click safe',
          }),
    },
    ...(update.state === 'error' && update.reason
      ? { error: update.reason }
      : {}),
  }
}

/** Honest stub row — DeepSeek harness is declared but not delivered. */
export function deepseekProviderStatusStub(): AgentProviderStatusDto {
  return {
    provider: 'deepseek-harness',
    targetId: 'runtime:deepseek-harness',
    registered: false,
    installed: false,
    binaryPath: null,
    version: null,
    latestVersion: null,
    updateAvailable: false,
    auth: { status: 'unknown' },
    install: {
      kind: 'unsupported',
      displayCommand: '',
      packageName: '',
      binaryName: 'deepseek-harness',
      managedNpm: false,
    },
    update: {
      capability: 'unsupported',
      unsupportedReason: 'DeepSeek harness adapter is not delivered yet',
    },
    error: 'adapter not yet delivered',
  }
}

/**
 * Merge daemon managed-provider status with Hermes (+ honest deepseek stub).
 * When the daemon is unreachable, still return Hermes/deepseek so Runtimes is
 * not empty — callers that require daemon-only data should check separately.
 */
export async function aggregateAgentRuntimeStatus(
  daemonStatus: AgentProviderStatusListDto | null,
  options?: UpdateCheckOptions,
): Promise<AgentProviderStatusListDto> {
  const hermes = await hermesProviderStatusRow(options)
  const deepseek = deepseekProviderStatusStub()
  const providers = [
    hermes,
    ...(daemonStatus?.providers ?? []),
    deepseek,
  ]
  return {
    capturedAt: daemonStatus?.capturedAt ?? new Date().toISOString(),
    providers,
  }
}
