/**
 * A minimal JSON repair state machine, local to this package.
 *
 * The plan (PHASE-2-PLAN.md §9.2) imports `repairJsonWithStateMachine` from
 * `@agentsy/core/structured`. That package and that export are on npm
 * (@agentsy/core@0.2.0), but the function is a streaming bracket-balancer: it
 * closes a truncated answer and drops a closer that closes nothing, and it
 * leaves a trailing comma and a raw control character inside a string
 * exactly as they are. A local model produces those two shapes constantly, so
 * the repair this package needs is written here.
 *
 * The three shapes it handles:
 *   - a truncated answer: the string and the brackets are closed
 *   - a trailing comma before a closing bracket
 *   - a raw newline or tab inside a string
 */

const OPENING_FENCE = /^```[^\n]*\n?/;
const CLOSING_FENCE = /```\s*$/;

/** What the machine knows while it reads the answer. */
interface RepairState {
  /** The answer as it is written out. */
  readonly out: string[];
  /** The brackets that are still open, innermost last. */
  readonly stack: string[];
  /** Where the last character that is not whitespace sits. */
  lastMeaningful: number;
  /** The machine is inside a string. */
  inString: boolean;
  /** The last character was a backslash. */
  escaped: boolean;
}

/** A code fence around the answer is packaging, not part of the JSON. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  return trimmed.replace(OPENING_FENCE, '').replace(CLOSING_FENCE, '').trim();
}

/** The whitespace JSON allows between tokens. */
function isSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

/** A control character has to be escaped to sit inside a JSON string. */
function escapeControl(char: string): string {
  switch (char) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    default:
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
}

/** Write a character that counts as content. */
function push(state: RepairState, char: string): void {
  state.out.push(char);
  state.lastMeaningful = state.out.length - 1;
}

/**
 * A comma before a closing bracket is a trailing comma, and it is dropped
 * when the bracket arrives. Holding it back is what makes that possible.
 */
function dropTrailingComma(state: RepairState): void {
  if (state.lastMeaningful < 0 || state.out[state.lastMeaningful] !== ',') return;
  state.out.splice(state.lastMeaningful, 1);
  let index = state.lastMeaningful - 1;
  while (index >= 0 && isSpace(state.out[index] ?? '')) index -= 1;
  state.lastMeaningful = index;
}

/** A character inside a string. */
function feedString(state: RepairState, char: string): void {
  if (state.escaped) {
    state.escaped = false;
    state.out.push(char);
    return;
  }
  if (char === '\\') {
    state.escaped = true;
    state.out.push(char);
    return;
  }
  if (char === '"') {
    state.inString = false;
    push(state, char);
    return;
  }
  if (char < ' ') {
    state.out.push(escapeControl(char));
    state.lastMeaningful = state.out.length - 1;
    return;
  }
  state.out.push(char);
}

/** A character outside a string. */
function feedStructure(state: RepairState, char: string): void {
  if (char === '"') {
    state.inString = true;
    push(state, char);
    return;
  }
  if (char === '{' || char === '[') {
    state.stack.push(char === '{' ? '}' : ']');
    push(state, char);
    return;
  }
  if (char === '}' || char === ']') {
    closeBracket(state, char);
    return;
  }
  state.out.push(char);
  if (!isSpace(char)) state.lastMeaningful = state.out.length - 1;
}

/** A closing bracket. One that closes nothing is dropped. */
function closeBracket(state: RepairState, char: string): void {
  if (state.stack.at(-1) !== char) return;
  state.stack.pop();
  dropTrailingComma(state);
  push(state, char);
}

/** Close what the answer left open. */
function closeAnswer(state: RepairState): string {
  if (state.inString) {
    state.out.push('"');
    state.lastMeaningful = state.out.length - 1;
  }
  dropTrailingComma(state);
  while (state.stack.length > 0) {
    state.out.push(state.stack.pop() ?? '');
    state.lastMeaningful = state.out.length - 1;
  }
  return state.out.join('');
}

/**
 * Repair an answer a local model produced. The answer comes back as JSON
 * text; it is not parsed here, so a repair that cannot help is harmless.
 */
export function repairJson(input: string): string {
  const state: RepairState = {
    out: [],
    stack: [],
    lastMeaningful: -1,
    inString: false,
    escaped: false,
  };
  for (const char of stripFence(input)) {
    if (state.inString) feedString(state, char);
    else feedStructure(state, char);
  }
  return closeAnswer(state);
}
