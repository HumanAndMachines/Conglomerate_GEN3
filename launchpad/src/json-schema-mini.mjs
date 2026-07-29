// Minimální draft-07 subset validátor (repo nemá ajv; validace je hand-rolled).
// Podporuje: type, required, enum, const, properties, additionalProperties:false,
// items, pattern, minimum, minItems, maxItems, uniqueItems, $ref (#/definitions/... i
// rekurzivní kořenové "#"), allOf, anyOf, contains, minLength, if/then/else, not
// a dependentRequired.
// Vrací pole chybových hlášek (prázdné = validní).

export function validateAgainstSchema(value, schema, label = "$") {
  const failures = [];
  validateNode(value, schema, label, failures, schema);
  return failures;
}

function validateNode(value, node, path, failures, rootSchema) {
  if (Object.prototype.hasOwnProperty.call(node, "const") && value !== node.const) {
    failures.push(`${path}: hodnota musí být ${JSON.stringify(node.const)}`);
    return;
  }
  if (node.$ref) {
    // Kořenový "#" je rekurzivní odkaz na celé schéma. Doctor report ho potřebuje
    // pro children[].report: vnořený report dítěte má PŘESNĚ stejný tvar jako
    // report rodiče, a kopie toho tvaru na druhém místě by se rozešla.
    if (node.$ref === "#") {
      validateNode(value, rootSchema, path, failures, rootSchema);
      return;
    }
    const ref = node.$ref.replace(/^#\//, "").split("/");
    let target = rootSchema;
    for (const key of ref) target = target?.[key];
    if (!target) {
      failures.push(`${path}: nerozpoznaný $ref ${node.$ref}`);
      return;
    }
    validateNode(value, target, path, failures, rootSchema);
    return;
  }
  if (
    Array.isArray(node.enum) &&
    !node.enum.some(
      (candidate) => stableStringify(candidate) === stableStringify(value),
    )
  ) {
    failures.push(
      `${path}: ${JSON.stringify(value)} není v enum [${node.enum
        .map((candidate) => JSON.stringify(candidate))
        .join(", ")}]`,
    );
  }
  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf) validateNode(value, sub, path, failures, rootSchema);
  }
  if (node.if && typeof node.if === "object") {
    const conditionFailures = [];
    validateNode(value, node.if, path, conditionFailures, rootSchema);
    const selectedBranch =
      conditionFailures.length === 0 ? node.then : node.else;
    if (selectedBranch && typeof selectedBranch === "object") {
      validateNode(value, selectedBranch, path, failures, rootSchema);
    }
  }
  if (node.not && typeof node.not === "object") {
    const branchFailures = [];
    validateNode(value, node.not, path, branchFailures, rootSchema);
    if (branchFailures.length === 0) {
      failures.push(`${path}: hodnota odpovídá zakázané 'not' větvi`);
    }
  }
  if (Array.isArray(node.anyOf)) {
    // Validní, pokud projde aspoň jedna větev; jinak souhrnná chyba.
    const passed = node.anyOf.some((sub) => {
      const branchFailures = [];
      validateNode(value, sub, path, branchFailures, rootSchema);
      return branchFailures.length === 0;
    });
    if (!passed) failures.push(`${path}: hodnota neodpovídá žádné anyOf větvi`);
  }
  // Draft-07: required/contains platí podle typu HODNOTY i bez node.type —
  // schema je používá v holých anyOf/allOf větvích (generation markery,
  // gitignored_local_paths). Vyhodnocení jen v typovaných větvích by tyhle
  // kontrakty tiše přeskočilo (Greptile PR #143).
  if (Array.isArray(node.required) && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of node.required) {
      if (!(key in value)) failures.push(`${path}: chybí povinné pole '${key}'`);
    }
  }
  const objectValue =
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (objectValue && node.dependentRequired && typeof node.dependentRequired === "object") {
    for (const [key, dependencies] of Object.entries(node.dependentRequired)) {
      if (!(key in value) || !Array.isArray(dependencies)) continue;
      for (const dependency of dependencies) {
        if (!(dependency in value)) {
          failures.push(
            `${path}: pole '${key}' vyžaduje související pole '${dependency}'`,
          );
        }
      }
    }
  }
  // JSON Schema object keywords platí i bez explicitního node.type. To je
  // zásadní pro if/then/else větve company schématu.
  if (objectValue && node.type !== "object" && node.properties) {
    const props = node.properties;
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) failures.push(`${path}: nepovolené pole '${key}'`);
      }
    }
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in value) {
        validateNode(value[key], subSchema, `${path}.${key}`, failures, rootSchema);
      }
    }
  }
  if (node.contains && typeof node.contains === "object" && Array.isArray(value)) {
    const anyMatch = value.some((item) => {
      const itemFailures = [];
      validateNode(item, node.contains, path, itemFailures, rootSchema);
      return itemFailures.length === 0;
    });
    if (!anyMatch) failures.push(`${path}: pole neobsahuje žádnou položku odpovídající 'contains'`);
  }
  if (typeof value === "string" && node.type !== "string") {
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      failures.push(`${path}: '${value}' neodpovídá pattern ${node.pattern}`);
    }
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      failures.push(`${path}: string má ${value.length} znaků, minimum ${node.minLength}`);
    }
  }
  if (node.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      failures.push(`${path}: očekáván object`);
      return;
    }
    const props = node.properties ?? {};
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) failures.push(`${path}: nepovolené pole '${key}'`);
      }
    }
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in value) validateNode(value[key], subSchema, `${path}.${key}`, failures, rootSchema);
    }
    return;
  }
  if (node.type === "array") {
    if (!Array.isArray(value)) {
      failures.push(`${path}: očekáváno pole`);
      return;
    }
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      failures.push(`${path}: pole má ${value.length} položek, minimum ${node.minItems}`);
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      failures.push(`${path}: pole má ${value.length} položek, maximum ${node.maxItems}`);
    }
    if (node.uniqueItems === true) {
      const seen = new Map();
      value.forEach((item, index) => {
        const key = stableStringify(item);
        if (seen.has(key)) {
          failures.push(`${path}[${index}]: duplicitní položka (stejná jako ${path}[${seen.get(key)}])`);
        } else {
          seen.set(key, index);
        }
      });
    }
    if (node.items) {
      value.forEach((item, index) => validateNode(item, node.items, `${path}[${index}]`, failures, rootSchema));
    }
    return;
  }
  if (node.type === "string") {
    if (typeof value !== "string") {
      failures.push(`${path}: očekáván string`);
      return;
    }
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      failures.push(`${path}: '${value}' neodpovídá pattern ${node.pattern}`);
    }
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      failures.push(`${path}: string má ${value.length} znaků, minimum ${node.minLength}`);
    }
    return;
  }
  if (node.type === "integer") {
    if (!Number.isInteger(value)) {
      failures.push(`${path}: očekáván integer`);
      return;
    }
    if (typeof node.minimum === "number" && value < node.minimum) {
      failures.push(`${path}: ${value} < minimum ${node.minimum}`);
    }
    return;
  }
  if (node.type === "boolean" && typeof value !== "boolean") {
    failures.push(`${path}: očekáván boolean`);
    return;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
