/**
 * REST принимает только объект полей, массив и null считаются некорректным ответом.
 * Проверка остаётся внутри пакета и не связывает его с реализацией host.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
