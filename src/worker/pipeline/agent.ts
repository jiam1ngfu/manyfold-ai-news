/**
 * One turn with an agent (writer, reviewer or answerer) over A2A message/stream. Each turn is a
 * billed call, so the messageId is derived from the stored run row and the step name:
 * a retried send of the same step can never bill twice.
 */

import { A2AError, consumeA2AStream } from '../a2a';
import type { AgentCredential } from '../types';
import { extractJson } from './draft';
import { repairPrompt } from './prompts';

const TURN_TIMEOUT_MS = 8 * 60 * 1000;

// How Manyfold reports a sandbox whose runner never came up (a slow wake, or a CLI update):
// "Chat runner unavailable (runner_unavailable). …". No turn ran and nothing was billed,
// but the task stays failed under its messageId, so only a new messageId can try again.
const RUNNER_DOWN = /\(runner_(?:unavailable|updating)\)/;

export class RunnerUnavailable extends A2AError {}

export async function agentTurn(cred: AgentCredential, messageId: string, text: string, timeoutMs = TURN_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const snapshot = await consumeA2AStream({
      cred,
      signal: controller.signal,
      params: {
        message: { kind: 'message', role: 'user', messageId, parts: [{ kind: 'text', text }] },
        configuration: { acceptedOutputModes: ['text/plain', 'application/json'] },
      },
    });
    if (snapshot.state && snapshot.state !== 'completed') {
      const message = `${cred.label} stopped at "${snapshot.state}"${snapshot.text ? `: ${snapshot.text.slice(0, 200).replace(/\.$/, '')}` : ''}.`;
      if (snapshot.state === 'failed' && RUNNER_DOWN.test(snapshot.text)) throw new RunnerUnavailable(message, true);
      throw new A2AError(message, false);
    }
    if (!snapshot.text.trim()) throw new A2AError(`${cred.label} finished without any text.`, true);
    return snapshot.text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A turn whose reply must be one JSON object. jsonrepair fixes the usual slips for free;
 * a reply still broken after that gets one more turn to fix its own syntax, under its own
 * messageId (`<messageId>-fix`), so a step bills at most one extra turn, and a retried
 * step rejoins both tasks instead of billing them again. `onRepair` reports that it happened.
 */
export async function jsonTurn(cred: AgentCredential, messageId: string, text: string, onRepair?: () => void): Promise<unknown> {
  const reply = await agentTurn(cred, messageId, text);
  try {
    return extractJson(reply);
  } catch (error) {
    onRepair?.();
    const problem = error instanceof Error ? error.message : String(error);
    return extractJson(await agentTurn(cred, `${messageId}-fix`, repairPrompt(reply, problem)));
  }
}
