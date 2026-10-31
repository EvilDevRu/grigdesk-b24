import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';
import { isRecord } from './objects.ts';

/**
 * Сворачивает REST-комментарий в поля, которые уже читает карточка GrigDesk.
 * Дата и текст сохраняются как у портала; отсутствующие сведения не выдумываются.
 */
export function comment(value: unknown): TaskData {
  if (!isRecord(value) || !Number.isSafeInteger(Number(value.ID)) || Number(value.ID) <= 0) {
    throw new TrackerError('tracker_rest_error', 'Портал не вернул номер комментария', 502);
  }

  const authorId = Number(value.AUTHOR_ID);

  return {
    mid: Number(value.ID),
    authorId: Number.isSafeInteger(authorId) && authorId > 0 ? authorId : null,
    author: String(value.AUTHOR_NAME ?? '').trim() || '—',
    time: String(value.POST_DATE ?? ''),
    text: String(value.POST_MESSAGE ?? ''),
    isSystem: false,
    unread: false,
    attachments: [],
  };
}
