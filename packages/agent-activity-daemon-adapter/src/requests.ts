import type {
  AgentActivityCreateSessionInput,
  AgentActivitySendInput,
  AgentPromptContentBlock,
  AgentSessionActivateEffectInput
} from "@agorax/agent-activity-core";
import type {
  DaemonCreateAgentSessionRequest,
  DaemonPromptContentBlock,
  DaemonSendAgentSessionInputRequest
} from "./daemonDtos.ts";

type NewAgentSessionActivationInput = Extract<
  AgentSessionActivateEffectInput,
  { mode: "new" }
>;

/**
 * Outbound projection for POST .../agent-sessions. Only fields declared by
 * the daemon decode struct (agorax-agentd/main.go) cross the HTTP boundary:
 * agentSessionId, agentTargetId, provider, clientSubmitId, content,
 * initialContent, cwd, model. Local prompt fields such as `uri`, `hostPath`,
 * `uploadStatus`, and `assetId` never cross the HTTP boundary.
 *
 * TODO(daemon-endpoint): fields the tuttid contract accepted but the daemon
 * decode struct lacks (capabilityRefs, initialGoalControl,
 * initialAgoraxModeActivation, railPlacement, permissionModeId, planMode,
 * reasoningEffort, speed, title, visible, browserUse/codexSaverMode/
 * rtkSaverMode, submitDiagnostics, modelExplicit, noProject) are dropped
 * until the daemon endpoint accepts them.
 */
export function daemonCreateAgentSessionRequestFromActivity(
  input: AgentActivityCreateSessionInput & { agentSessionId: string }
): DaemonCreateAgentSessionRequest {
  return {
    agentSessionId: input.agentSessionId,
    agentTargetId: input.agentTargetId,
    clientSubmitId: input.clientSubmitId,
    // The daemon falls back to initialContent when content is empty; hosts
    // follow the tuttid convention of sending initialContent at create time.
    initialContent: daemonPromptContentBlocksFromActivity(
      input.initialContent ?? []
    ),
    ...(input.cwd?.trim() ? { cwd: input.cwd } : {}),
    ...(input.model?.trim() ? { model: input.model } : {})
  };
}

/**
 * Activation-input variant of the create projection. Only the daemon-supported
 * subset is forwarded (identity, initial content, cwd, model); engine-only
 * settings are dropped per the TODO above.
 */
export function daemonCreateAgentSessionRequestFromActivation(
  input: NewAgentSessionActivationInput
): DaemonCreateAgentSessionRequest {
  return daemonCreateAgentSessionRequestFromActivity({
    agentSessionId: input.agentSessionId,
    agentTargetId: input.agentTargetId,
    clientSubmitId: input.clientSubmitId,
    cwd: input.cwd,
    initialContent: input.initialContent
      ? input.initialContent.map((block) => ({ ...block }))
      : undefined,
    model: input.settings?.model,
    workspaceId: input.workspaceId
  });
}

/**
 * Outbound projection for POST .../input. The daemon decode struct accepts
 * only clientSubmitId and content; displayPrompt, guidance/targetTurnId,
 * capabilityRefs, and submitDiagnostics are dropped
 * TODO(daemon-endpoint).
 */
export function daemonSendAgentSessionInputRequestFromActivity(
  input: AgentActivitySendInput
): DaemonSendAgentSessionInputRequest {
  return {
    clientSubmitId: input.clientSubmitId,
    content: daemonPromptContentBlocksFromActivity(input.content)
  };
}

function daemonPromptContentBlocksFromActivity(
  content: readonly AgentPromptContentBlock[]
): DaemonPromptContentBlock[] {
  return content.map((block) => {
    if (block.type === "file") {
      throw new Error("File prompt blocks must be uploaded before submission");
    }
    if (
      block.type !== "text" &&
      block.type !== "image" &&
      block.type !== "skill" &&
      block.type !== "mention" &&
      block.type !== "connector"
    ) {
      throw new Error("Unsupported workspace agent prompt content block");
    }
    const nextBlock: DaemonPromptContentBlock = { type: block.type };
    if (block.attachmentId !== undefined) {
      nextBlock.attachmentId = block.attachmentId;
    }
    if (block.data !== undefined) {
      nextBlock.data = block.data;
    }
    if (block.url !== undefined) {
      nextBlock.url = block.url;
    }
    if (block.mimeType !== undefined) {
      if (
        block.mimeType !== "image/png" &&
        block.mimeType !== "image/jpeg" &&
        block.mimeType !== "image/webp"
      ) {
        throw new Error("Unsupported workspace agent prompt image MIME type");
      }
      nextBlock.mimeType = block.mimeType;
    }
    if (block.name !== undefined) {
      nextBlock.name = block.name;
    }
    if (block.path !== undefined) {
      nextBlock.path = block.path;
    }
    if (block.connectorKey !== undefined) {
      nextBlock.connectorKey = block.connectorKey;
    }
    if (block.text !== undefined) {
      nextBlock.text = block.text;
    }
    return nextBlock;
  });
}
