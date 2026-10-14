export function createKnownSecretChecker(values: readonly string[]) {
  const secrets = [...new Set(values.filter(Boolean))]
    .flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  function contains(value: unknown): boolean {
    if (typeof value === "string")
      return secrets.some((secret) => value.includes(secret));
    if (Array.isArray(value)) return value.some(contains);
    if (value !== null && typeof value === "object")
      return Object.entries(value).some(
        ([key, item]) => contains(key) || contains(item),
      );
    return false;
  }

  function redact(message: string) {
    for (const secret of secrets)
      message = message.replaceAll(secret, "[redacted]");
    return message;
  }

  return Object.freeze({ contains, redact });
}

export type KnownSecretChecker = ReturnType<typeof createKnownSecretChecker>;

export function createSafeLogger(checker: KnownSecretChecker) {
  return Object.freeze({
    info: (message: string) =>
      console.log(checker.redact(message).slice(0, 2048)),
    error: (message: string) =>
      console.error(checker.redact(message).slice(0, 2048)),
  });
}

export type SafeLogger = ReturnType<typeof createSafeLogger>;
