import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';
import { isRecord } from './objects.ts';

const FIELD_NAMES: Record<string, string> = {
  title: 'TITLE',
  description: 'DESCRIPTION',
  responsibleId: 'RESPONSIBLE_ID',
  deadline: 'DEADLINE',
  groupId: 'GROUP_ID',
  priority: 'PRIORITY',
  accomplices: 'ACCOMPLICES',
  auditors: 'AUDITORS',
};

/**
 * Проверяет частичное обновление до сети и переводит только заданные поля в REST.
 * Пустое описание и снятие срока значимы; пропущенные поля не получают значений по умолчанию.
 */
export function taskUpdateFields(input: unknown): TaskData {
  if (!isRecord(input)) {
    throw new TrackerError('tracker_bad_request', 'Поля задачи должны быть объектом');
  }

  const fields: TaskData = {};

  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(FIELD_NAMES, key)) {
      throw new TrackerError('tracker_bad_request', `Неизвестное поле задачи: ${key}`);
    }

    if (value === undefined) {
      continue;
    }

    let normalized = value;

    if (key === 'title' && (typeof value !== 'string' || !value.trim())) {
      throw new TrackerError('tracker_bad_request', 'Заголовок задачи не может быть пустым');
    }

    if (key === 'description' && typeof value !== 'string') {
      throw new TrackerError('tracker_bad_request', 'Описание задачи должно быть строкой');
    }

    if (key === 'deadline' && value !== null && typeof value !== 'string') {
      throw new TrackerError('tracker_bad_request', 'Срок задачи должен быть строкой или null');
    }

    if (key === 'responsibleId' || key === 'groupId') {
      normalized = key === 'groupId' && (value === null || value === '') ? 0 : Number(value);

      if (!Number.isSafeInteger(normalized) || Number(normalized) < (key === 'groupId' ? 0 : 1)) {
        throw new TrackerError('tracker_bad_request', 'Некорректный номер исполнителя или проекта');
      }
    }

    if (key === 'priority' && (value === null || value === '' || ![0, 1, 2].includes(Number(value)))) {
      throw new TrackerError('tracker_bad_request', 'Приоритет задачи должен быть 0, 1 или 2');
    }

    if (key === 'accomplices' || key === 'auditors') {
      if (value === '' || value === null) {
        normalized = '';
      } else if (Array.isArray(value)) {
        normalized = value.map((id) => {
          if ((typeof id !== 'number' && typeof id !== 'string')
            || (typeof id === 'string' && !/^\d+$/u.test(id))
            || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
            throw new TrackerError('tracker_bad_request', 'Участники: нужны положительные id');
          }

          return Number(id);
        });

        if (!value.length) {
          normalized = '';
        }
      } else {
        throw new TrackerError('tracker_bad_request', 'Участники: нужен массив id, пустая строка или null');
      }
    }

    fields[FIELD_NAMES[key]] = normalized;
  }

  if (!Object.keys(fields).length) {
    throw new TrackerError('tracker_bad_request', 'Не передано ни одного изменения задачи');
  }

  return fields;
}
