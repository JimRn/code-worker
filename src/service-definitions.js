// Service capability definitions (P1): the contract each ctx service may
// expose to consumers. Context.provide() wraps a provided service in a
// read-only view that exposes ONLY these members — providers can be
// swapped without leaking internals, and consumers cannot reach beyond
// the declared capability surface. Keys not listed here (plain data such
// as modelConfig, or function services such as "isolate") pass through.
export const SERVICE_METHODS = {
  fs: ["root", "resolve", "readFile", "writeFile", "listDir", "listEntries", "withRoot"],
  shell: ["workspace", "resolveSpec", "run", "withWorkspace"],
  tools: ["register", "list", "schemas", "execute"],
  llm: ["registerAdapter", "prepareCall"],
  sessions: ["homeDir", "projectsDir", "create", "open", "listLight", "softDelete", "restore", "listTrash", "registerEventType"],
  projects: ["dir", "create", "list", "get", "addRepo", "importRepo", "repoDir", "instructions"],
  settings: ["describe", "update", "getWorkspace", "setWorkspace", "getApiKey", "getConfig"],
  agentLoop: ["provider", "maxSteps", "toolResultMaxBytes", "currentModel", "runTurn", "cancel", "inject"],
  compaction: ["prune", "compact", "maybeCompact", "overBudget"],
  fileCache: ["read", "clear"],
};

/** Is this service worth wrapping? Only real services (with a listed method). */
export function shouldWrap(key, service) {
  if (!Object.hasOwn(SERVICE_METHODS, key)) return false;
  if (!service || (typeof service !== "object" && typeof service !== "function")) return false;
  return SERVICE_METHODS[key].some((m) => typeof service[m] === "function" || service[m] !== undefined);
}

/** Read-only capability view: listed members only, methods bound to the target. */
export function wrapService(key, service) {
  const allowed = new Set(SERVICE_METHODS[key]);
  return new Proxy(service, {
    get(target, prop) {
      if (typeof prop !== "string") return Reflect.get(target, prop);
      if (!allowed.has(prop)) return undefined;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
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
  });
}
