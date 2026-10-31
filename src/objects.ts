/**
 * REST принимает только объект полей, массив и null считаются некорректным ответом.
 * Проверка остаётся внутри пакета и не связывает его с реализацией host.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Текст портала остаётся понятным, но не раскрывает реквизиты и действующую сессию.
 * Убираются также URL-кодированные и JSON-экранированные варианты известных секретов.
 */
export function redactSecrets(message: string, secrets: Array<string | null>): string {
  const variants = secrets.filter((value): value is string => Boolean(value)).flatMap((value) => [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]).sort((left, right) => right.length - left.length);

  for (const value of variants) {
    message = message.split(value).join('[скрыто]');
  }

  return message;
}
