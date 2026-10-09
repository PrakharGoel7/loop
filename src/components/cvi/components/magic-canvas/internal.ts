export function isCanvasRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepFreezeCanvasValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const key of Reflect.ownKeys(value))
    deepFreezeCanvasValue((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}
