/**
 * Context-budget guard for media text that gets injected into the agent's session.
 *
 * Enrichment (document extraction, audio transcription) appends the result as the
 * user's message, where it persists in history. A single over-limit message cannot
 * be summarized away by compaction, so it pins the session in an overflow-compaction
 * loop — worst on small-context models (e.g. 110k tokens). Bound what enters context:
 * over the budget, persist the full text next to the source and inject only the head
 * plus a pointer the agent can `read`/`grep` on demand.
 */

import { writeFile } from 'node:fs/promises';
import { createLogger } from '../../lib/logger.js';
import { toMessage } from '../../lib/error.js';

const log = createLogger('media');

/**
 * Default ceiling on media text injected into the agent's context.
 * ~100k chars ≈ 25k tokens — safe headroom on a 110k-context model.
 * Override per install via `agent.media.maxExtractChars`.
 */
export const DEFAULT_MAX_EXTRACT_CHARS = 100_000;

/**
 * Bound text destined for the agent's context. Under budget the text is returned
 * unchanged; over budget the full text is written to `fullTextPath` and the head
 * (plus a pointer) is returned.
 */
export async function boundForContext(
  text: string,
  fullTextPath: string,
  maxChars: number,
  label: string,
): Promise<string> {
  if (text.length <= maxChars) return text;

  try {
    await writeFile(fullTextPath, text, 'utf-8');
  } catch (err) {
    log.warn(`failed to persist full ${label} for ${fullTextPath}: ${toMessage(err)}`);
    return `${text.slice(0, maxChars)}\n…[truncated: showing first ${maxChars} of ${text.length} characters; full ${label} could not be saved to disk]`;
  }

  return `${text.slice(0, maxChars)}\n…[truncated: showing first ${maxChars} of ${text.length} characters. Full ${label} saved at ${fullTextPath} — read or grep it on demand.]`;
}
