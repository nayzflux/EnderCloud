export function jsonParameter(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) {
    throw new Error("Value cannot be represented as JSON");
  }
  return serialized;
}
