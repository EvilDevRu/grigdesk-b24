import type { TaskTracker, TrackerHost } from './types/contract.ts';
import { createStockTracker } from './src/client.ts';

/**
 * Точка входа получает реквизиты и транспорт только через общий host-контракт.
 * Сетевой клиент и семантика Битрикса принадлежат исключительно этому пакету.
 */
export default function createDriver(host: TrackerHost): TaskTracker {
  return createStockTracker(host, host.fetch);
}
