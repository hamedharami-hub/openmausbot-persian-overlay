function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(keys.filter((key) => ["string", "boolean", "number"].includes(typeof source[key])).map((key) => [key, source[key]]));
}

/** Client catalogs expose model choices, never account identities, credentials or executable configuration. */
export function clientInstanceCatalog(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = record(entry);
    if (typeof source.instanceId !== "string" || typeof source.driverKind !== "string") return [];
    const models = record(source.models);
    const capabilities = fields(source.capabilities, ["sessionModelSwitch", "agentsMcp", "computerMcp", "composioMcp", "phoneMcp", "browserMcp", "dataMcp", "highlevelMcp", "images", "nativeImageInput", "modelVariants", "queueing", "steerImages", "localComputerMcp", "customMcp", "approvalReview", "backgroundText"]);
    const effort = record(source.capabilities).effortLevels;
    if (Array.isArray(effort)) capabilities.effortLevels = effort.filter((item) => typeof item === "string");
    return [{
      ...fields(source, ["instanceId", "driverKind", "displayName", "readOnly", "access"]),
      snapshot: fields(source.snapshot, ["state", "authenticated", "version", "billing", "chatgptPlan"]),
      models: {
        default: typeof models.default === "string" ? models.default : "",
        options: Array.isArray(models.options) ? models.options.flatMap((option) => {
          const model = record(option);
          if (typeof model.id !== "string" || typeof model.label !== "string") return [];
          return [{ ...fields(model, ["id", "label", "custom", "loaded", "provider", "contextWindow"]),
            ...(Array.isArray(model.variants) ? { variants: model.variants.flatMap((variant) => {
              const v = record(variant);
              return typeof v.id === "string" && typeof v.label === "string" ? [fields(v, ["id", "label"])] : [];
            }) } : {}) }];
        }) : [],
      },
      capabilities,
    }];
  });
}
