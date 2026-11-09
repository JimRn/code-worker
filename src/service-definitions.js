// Service capability definitions (P1): the contract each ctx service may
// expose to consumers. Context.provide() wraps a provided service in a
// read-only view that exposes ONLY these members — providers can be
// swapped without leaking internals, and consumers cannot reach beyond
// the declared capability surface. Plugins declare their own via
// ctx.registerMethods(key, [...]) at apply time; this table is only the
// built-in defaults. Keys not listed (plain data such as modelConfig, or
// function services such as "isolate") pass through.
//
// NOTE: the view is hygiene, not a security boundary — determined code in
// the same process can still reach the target via reflection hacks if it
// holds a direct reference. Security relies on ctx isolation + plugin review.
export const SERVICE_METHODS = {
  fs: ["root", "resolve", "readFile", "writeFile", "listDir", "listEntries", "withRoot"],
  shell: ["workspace", "resolveSpec", "run", "withWorkspace"],
  tools: ["register", "list", "schemas", "execute"],
  llm: ["registerAdapter", "prepareCall"],
  sessions: ["homeDir", "projectsDir", "create", "open", "listLight", "softDelete", "restore", "listTrash", "projectDir", "registerEventType", "registerProjection", "registerTitleReader", "registerDerived"],
  projects: ["dir", "create", "list", "get", "dirOf", "projectDir", "addRepo", "importRepo", "repoDir", "instructions"],
  settings: ["describe", "update", "getWorkspace", "setWorkspace", "getModelConfig"], // getModelConfig: model fields only, no credentials file access
  agentLoop: ["provider", "maxSteps", "toolResultMaxBytes", "currentModel", "runTurn", "cancel", "inject"],
  compaction: ["prune", "compact", "maybeCompact", "overBudget"],
  fileCache: ["read", "clear"],
  terminals: ["open", "send", "read", "close", "writeRaw", "subscribe", "resize"],
};

/** Is this service worth wrapping? Only real services (with a listed method).
 * Registry precedence: plugin-declared methods, else built-in defaults. */
export function shouldWrap(key, service, registry) {
  const methods = registry?.get?.(key) ?? SERVICE_METHODS[key];
  if (!methods) return false;
  if (!service || (typeof service !== "object" && typeof service !== "function")) return false;
  return methods.some((m) => typeof service[m] === "function" || service[m] !== undefined);
}

/** Read-only capability view: listed members only, methods bound to the target. */
export function wrapService(key, service, registry) {
  const allowed = new Set(registry?.get?.(key) ?? SERVICE_METHODS[key]);
  const bound = new Map(); // stable bound-method identity across gets
  return new Proxy(service, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      if (!allowed.has(prop)) return undefined;
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (!bound.has(prop)) bound.set(prop, value.bind(target));
      return bound.get(prop);
    },
    set(target, prop, value) {
      if (typeof prop === "string" && allowed.has(prop)) return Reflect.set(target, prop, value);
      return false;
    },
    has(target, prop) { return typeof prop === "string" ? allowed.has(prop) : Reflect.has(target, prop); },
    ownKeys() { return [...allowed]; },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && allowed.has(prop)) return { enumerable: true, configurable: true };
      return undefined;
    },
    // Escape-proofing: no prototype/constructor reach, no mutation via
    // defineProperty/deleteProperty, no indirect freezing of the target.
    getPrototypeOf() { return null; },
    setPrototypeOf() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; },
    isExtensible() { return true; },
    preventExtensions() { return false; },
  });
}
