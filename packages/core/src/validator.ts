import Ajv, { ValidateFunction } from 'ajv';
import { toErrorMessage } from './errors.js';
import { JSONSchema } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

// Compile is the most expensive Ajv operation (it walks the schema and builds
// a validator function). Cache compiled validators per-schema-object so repeat
// calls (e.g. the same tool invoked every round) hit the cache.
const validators = new WeakMap<JSONSchema, ValidateFunction>();

function getValidator(schema: JSONSchema): ValidateFunction {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  return validate;
}

/**
 * Compiles (and caches) a JSON Schema at registration time, throwing if Ajv
 * rejects it. This is the registration-time gate: a malformed schema (an
 * unresolvable `$ref`, an invalid keyword value, a recursive `$ref` that
 * stack-overflows) is rejected before it enters the registry — so it is never
 * advertised to the LLM via `toLLMTools()` and never re-compiled per round.
 * Mirrors the risk-tier invariant in `agent.registerFunction`: fail-fast at
 * registration, not per call.
 *
 * The compiled validator is cached in the same WeakMap `validateArgs` reads,
 * so the per-round call hits the cache (no re-compile). On a throwing compile
 * the broken validator is deliberately NOT cached — a future schema fix takes
 * effect on the next registration attempt.
 */
export function compileSchema(schema: JSONSchema): void {
  getValidator(schema); // throws on compile failure; caches on success
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /**
   * Present when the JSON Schema itself could not be compiled by Ajv (a
   * malformed schema — e.g. an unresolvable `$ref` or an invalid keyword
   * value such as `type: 'notatype'`). When set, `valid` is `false` and
   * `errors` is empty: the failure is in the schema, not the args, so per-arg
   * error messages are meaningless. Carries the schema path/message Ajv
   * reported (e.g. `data/properties/x/type must be equal to one of the
   * allowed values`). The executor surfaces this as a `validation_failed`
   * audit event and skips the call rather than letting the throw crash the
   * run. Not cached — see `getValidator`.
   *
   * This is the **defense-in-depth backstop**. The primary gate is
   * `compileSchema`, called at registration time by `agent.registerFunction`,
   * which rejects a malformed schema before it enters the registry. This
   * catch covers the residual case where a schema reaches `validateArgs`
   * without going through the agent (e.g. a `FunctionRegistry` used directly,
   * or a future bypass): the run is still not crashed — the call is skipped
   * with a `validation_failed` event. A schema that compiled at registration
   * is cached, so the per-round call never re-compiles and never throws here.
   */
  compileError?: string;
}

export function validateArgs(args: Record<string, unknown>, schema: JSONSchema): ValidationResult {
  let validate: ValidateFunction;
  try {
    validate = getValidator(schema);
  } catch (err) {
    // Defense-in-depth backstop (see `compileSchema`): the primary gate is
    // registration-time, which rejects a malformed schema before it enters the
    // registry. This catch covers a schema that reached `validateArgs`
    // without going through the agent — surface it as a validation failure
    // with the schema path/message so the executor emits `validation_failed`
    // and skips the call, instead of letting the throw propagate unguarded
    // and abort the whole run. We deliberately do NOT cache a broken
    // validator: a recursive `$ref` may stack-overflow on every compile
    // attempt (a recursion/`$ref`-depth cap is deferred to P4.5); re-compiling
    // each round is the safe default for the backstop path.
    const message = toErrorMessage(err);
    return { valid: false, errors: [], compileError: message };
  }

  const valid = validate(args);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors ?? []).map((err) => {
    const field = err.instancePath ? err.instancePath.replace(/^\//, '') : 'root';
    return `${field}: ${err.message ?? 'unknown error'}`;
  });

  return { valid: false, errors };
}
