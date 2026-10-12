/**
 * One turn with an agent (writer, reviewer or answerer) over A2A message/stream. Each turn is a
 * billed call, so the messageId is derived from the stored run row and the step name:
 * a retried send of the same step can never bill twice.
 */

import { A2AError, consumeA2AStream } from '../a2a';
import type { AgentCredential } from '../types';

const TURN_TIMEOUT_MS = 8 * 60 * 1000;

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
      throw new A2AError(`${cred.label} stopped at "${snapshot.state}"${snapshot.text ? `: ${snapshot.text.slice(0, 200)}` : ''}.`, false);
    }
    if (!snapshot.text.trim()) throw new A2AError(`${cred.label} finished without any text.`, true);
    return snapshot.text;
  } finally {
    clearTimeout(timer);
  }
}
