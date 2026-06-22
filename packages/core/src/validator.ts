import Ajv, { ValidateFunction } from 'ajv';
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

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateArgs(args: Record<string, unknown>, schema: JSONSchema): ValidationResult {
  const validate = getValidator(schema);
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
