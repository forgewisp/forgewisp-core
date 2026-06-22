/**
 * A tiny, safe arithmetic expression evaluator.
 *
 * No `eval`, no `new Function`, no `setTimeout(string)`. The grammar is closed —
 * only `+ - * / % ^`, parentheses, decimal numbers, and unary `+`/`-` are accepted;
 * every other character (letters, identifiers, `=`, `,`, etc.) is a lex error. The
 * only external calls are `Number()`, `Math.pow`, and basic arithmetic, so there is
 * no path to property access, identifier resolution, or code execution.
 *
 * Pipeline: `tokenize` → `toRPN` (shunting-yard) → `evalRPN` (stack machine).
 *
 * Grammar (whitespace between tokens is allowed and skipped):
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := unary ('^' unary)*          // right-associative: 2^3^2 = 2^(3^2) = 512
 *   unary   := ('-' | '+') unary | primary
 *   primary := number | '(' expr ')'
 *   number  := digit+ ('.' digit+)?        // trailing '.' is invalid
 */

type Operator = '+' | '-' | '*' | '/' | '%' | '^' | 'u-';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; op: Operator }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const PRECEDENCE: Record<Operator, number> = {
  'u-': 5,
  '^': 4,
  '*': 3,
  '/': 3,
  '%': 3,
  '+': 2,
  '-': 2,
};

/** `^` is right-associative; everything else is left-associative. */
function isRightAssociative(op: Operator): boolean {
  return op === '^';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isOperatorChar(ch: string): boolean {
  return '+-*/%^()'.includes(ch);
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      out.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      out.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (isOperatorChar(ch)) {
      out.push({ kind: 'op', op: ch as Operator });
      i++;
      continue;
    }
    if (isDigit(ch) || ch === '.') {
      let j = i;
      let seenDot = false;
      while (j < src.length) {
        const c = src[j] ?? '';
        if (isDigit(c)) {
          j++;
          continue;
        }
        if (c === '.' && !seenDot) {
          seenDot = true;
          j++;
          continue;
        }
        break;
      }
      const text = src.slice(i, j);
      // Reject leading '.', trailing '.', or a lone '.'.
      if (text === '.' || text.startsWith('.') || text.endsWith('.')) {
        throw new Error(`Invalid number "${text}"`);
      }
      out.push({ kind: 'num', value: Number(text) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }
  return out;
}

/** A `-`/`+` is unary when it is at the start, or follows an operator or `(`. */
function isUnaryContext(prev: Token | null): boolean {
  if (prev === null) return true;
  return prev.kind === 'op' || prev.kind === 'lparen';
}

function toRPN(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const ops: Token[] = [];
  let prev: Token | null = null;

  for (const t of tokens) {
    if (t.kind === 'num') {
      output.push(t);
      prev = t;
      continue;
    }
    if (t.kind === 'lparen') {
      ops.push(t);
      prev = t;
      continue;
    }
    if (t.kind === 'rparen') {
      let foundLparen = false;
      while (ops.length > 0) {
        const top = ops[ops.length - 1]!;
        if (top.kind === 'lparen') {
          foundLparen = true;
          break;
        }
        output.push(ops.pop()!);
      }
      if (!foundLparen) {
        throw new Error('Mismatched ")"');
      }
      ops.pop(); // discard the lparen
      prev = t;
      continue;
    }

    // Operator token.
    let op = t.op;
    if ((op === '-' || op === '+') && isUnaryContext(prev)) {
      if (op === '+') {
        // Unary `+` is a no-op; don't emit anything.
        prev = t;
        continue;
      }
      op = 'u-';
    }

    while (ops.length > 0) {
      const top = ops[ops.length - 1]!;
      if (top.kind === 'lparen') break;
      if (top.kind !== 'op') break;
      const topPrec = PRECEDENCE[top.op];
      const curPrec = PRECEDENCE[op];
      if (topPrec > curPrec || (topPrec === curPrec && !isRightAssociative(op))) {
        output.push(ops.pop()!);
      } else {
        break;
      }
    }
    ops.push({ kind: 'op', op });
    prev = t;
  }

  while (ops.length > 0) {
    const op = ops.pop()!;
    if (op.kind === 'lparen' || op.kind === 'rparen') {
      throw new Error('Mismatched "("');
    }
    output.push(op);
  }
  return output;
}

function evalRPN(rpn: Token[]): number {
  const stack: number[] = [];
  for (const t of rpn) {
    if (t.kind === 'num') {
      stack.push(t.value);
      continue;
    }
    if (t.kind !== 'op') {
      throw new Error('Malformed expression');
    }
    if (t.op === 'u-') {
      const a = stack.pop();
      if (a === undefined) throw new Error('Malformed expression');
      stack.push(-a);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) {
      throw new Error('Malformed expression');
    }
    let r: number;
    switch (t.op) {
      case '+':
        r = a + b;
        break;
      case '-':
        r = a - b;
        break;
      case '*':
        r = a * b;
        break;
      case '/':
        if (b === 0) throw new Error('Division by zero');
        r = a / b;
        break;
      case '%':
        if (b === 0) throw new Error('Modulo by zero');
        r = a % b;
        break;
      case '^':
        r = Math.pow(a, b);
        break;
      default:
        throw new Error('Malformed expression');
    }
    stack.push(r);
  }
  if (stack.length !== 1) {
    throw new Error('Malformed expression');
  }
  const result = stack[0]!;
  if (!Number.isFinite(result)) {
    throw new Error('Result is not finite (overflow?)');
  }
  return result;
}

/**
 * Evaluate a safe arithmetic expression and return the numeric result.
 *
 * @throws Error on any lex/parse/eval failure, division/modulo by zero, or a
 *   non-finite (overflow) result. The error message is suitable to surface back
 *   to the model as a tool error.
 */
export function evaluateExpression(src: string): number {
  if (typeof src !== 'string' || src.length === 0 || src.length > 200) {
    throw new Error('Expression must be 1..200 characters');
  }
  const tokens = tokenize(src);
  if (tokens.length === 0) {
    throw new Error('Empty expression');
  }
  const rpn = toRPN(tokens);
  return evalRPN(rpn);
}
