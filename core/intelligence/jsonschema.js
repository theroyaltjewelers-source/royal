/* A small JSON Schema validator for the subset ROYAL uses to check what a
   model returns: type (object, array, string, number, integer, boolean,
   null, or a list of these), enum, const, properties, required,
   additionalProperties: false, items, minItems, maxItems, minLength,
   maxLength, minimum, maximum.

   A model's structured reply is accepted only if it passes.  Nothing is
   repaired: a reply that does not match is a failure.  The same schemas are
   sent to the provider as its structured-output format, so the model is
   asked for exactly what is checked. */

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function typeOk(v, t) {
  const actual = typeOf(v);
  const want = Array.isArray(t) ? t : [t];
  return want.some((w) => w === actual || (w === "number" && actual === "integer"));
}

export function validate(schema, value, path = "$", errors = []) {
  if (!schema || errors.length > 20) return errors;
  if (schema.type && !typeOk(value, schema.type)) { errors.push(path + " should be " + [].concat(schema.type).join("|")); return errors; }
  if (schema.const !== undefined && value !== schema.const) errors.push(path + " should be " + JSON.stringify(schema.const));
  if (schema.enum && schema.enum.indexOf(value) < 0) errors.push(path + " should be one of " + schema.enum.join(", "));
  const t = typeOf(value);
  if (t === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(path + " is longer than " + schema.maxLength);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(path + " is shorter than " + schema.minLength);
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(path + " is below " + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(path + " is above " + schema.maximum);
  }
  if (t === "array") {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(path + " has more than " + schema.maxItems + " items");
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(path + " has fewer than " + schema.minItems + " items");
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, path + "[" + i + "]", errors));
  }
  if (t === "object") {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (!(r in value)) errors.push(path + "." + r + " is required");
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, path + "." + k, errors);
      else if (schema.additionalProperties === false) errors.push(path + "." + k + " is not allowed");
    }
  }
  return errors;
}

export function check(schema, value) {
  const errors = validate(schema, value);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* Helpers for writing schemas compactly.  Strict mode at the provider needs
   every property listed in `required` and additionalProperties false, so
   optional fields are expressed as nullable. */
export const S = {
  str: (max = 2000, extra = {}) => ({ type: "string", maxLength: max, ...extra }),
  nstr: (max = 2000) => ({ type: ["string", "null"], maxLength: max }),
  num: () => ({ type: "number" }),
  nnum: () => ({ type: ["number", "null"] }),
  bool: () => ({ type: "boolean" }),
  enm: (values) => ({ type: "string", enum: values }),
  nenm: (values) => ({ type: ["string", "null"], enum: values.concat([null]) }),
  arr: (items, max = 50) => ({ type: "array", items, maxItems: max }),
  obj: (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false }),
};
