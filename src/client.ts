import { NO_TRACKER_CAPABILITIES } from '../types/capabilities.ts';
import { isRecord } from './objects.ts';
import { describeStatus } from './status.ts';
import { TrackerError } from '../types/contract.ts';
import type { TaskData, TaskTracker, TrackerHost, TrackerIdentity } from '../types/contract.ts';

/**
 * Облачный клиент выполняет только исходящий REST с токеном в теле POST.
 * Нет переноса токена при redirect, повторов мутаций и резервного HTML-протокола.
 */
export function createStockTracker(host: TrackerHost, transport: typeof fetch = fetch): TaskTracker {
  let identity: { signature: string; value: TrackerIdentity } | null = null;

  /**
   * Origin проверяется перед каждым обращением, включая смену реквизитов.
   * Реквизиты URL, путь, query и небезопасная схема не становятся адресом REST.
   */
  function credentials() {
    const values = host.credentials.read();
    const url = new URL(String(values?.baseUrl ?? ''));

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || typeof values?.accessToken !== 'string' || !values.accessToken) {
      throw new TrackerError('tracker_unavailable', 'Облачный трекер не настроен');
    }

    return { origin: url.origin, accessToken: values.accessToken };
  }

  /**
   * Внешний текст ошибки может содержать токен, поэтому наружу идут только наши сообщения.
   * Сетевой срок ограничен и тем же signal управляет транспорт фикстуры и настоящий fetch.
   */
  async function rest(method: string, fields: TaskData = {}): Promise<TaskData> {
    const { origin, accessToken } = credentials();

    try {
      const response = await transport(`${origin}/rest/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, auth: accessToken }),
      });
      const body: unknown = await response.json();

      if (isRecord(body) && body.error === 'TASK_NOT_FOUND') {
        throw new TrackerError('task_not_found', 'Задача не найдена', 404);
      }

      if (!response.ok || !isRecord(body) || body.error || !Object.hasOwn(body, 'result')) {
        throw new Error('Некорректный ответ REST');
      }

      return body;
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }

      throw new TrackerError('tracker_rest_error', 'Не удалось выполнить запрос облачного трекера', 502);
    }
  }

  /**
   * Идентичность кешируется только для точного набора реквизитов.
   * Смена токена того же портала не сохраняет пользователя предыдущего аккаунта.
   */
  async function accountIdentity(): Promise<TrackerIdentity> {
    const creds = credentials();
    const signature = JSON.stringify(creds);

    if (identity?.signature === signature) {
      return { ...identity.value };
    }

    const response = await rest('user.current');
    const user = isRecord(response.result) ? response.result : {};
    const userId = Number(user.ID);

    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new TrackerError('tracker_rest_error', 'Облако не вернуло пользователя', 502);
    }

    const value = { baseUrl: creds.origin, userId: String(userId) };

    identity = { signature, value };

    return { ...value };
  }

  /**
   * REST-поля переводятся в прежние имена карточки и доски.
   * Отсутствующий таймер не изображается остановленным таймером.
   */
  function task(value: unknown, userId: unknown): TaskData {
    if (!isRecord(value) || !Number.isSafeInteger(Number(value.id)) || Number(value.id) <= 0) {
      throw new TrackerError('tracker_rest_error', 'Облако не вернуло номер задачи', 502);
    }

    const state = describeStatus({ ...value, creatorId: value.createdBy }, userId);

    return {
      ...value,
      statusKind: state.kind,
      statusText: state.label,
      id: Number(value.id),
      source: 'b24',
      title: String(value.title ?? ''),
      description: String(value.description ?? ''),
      status: Number(value.status),
      responsibleId: Number(value.responsibleId),
      createdBy: Number(value.createdBy),
      groupId: Number(value.groupId) || null,
      priority: Number(value.priority) || 0,
    };
  }

  /**
   * Все страницы каждой роли читаются до явного конца, без дублирования задач.
   * Облако само применяет права; фильтр роли не превращает все видимые задачи в личные.
   */
  async function list(filter: TaskData): Promise<TaskData[]> {
    const rows = new Map<number, TaskData>();
    const visited = new Set<number>();
    let start = 0;

    do {
      visited.add(start);

      const response = await rest('tasks.task.list', {
        filter,
        order: { ID: 'ASC' },
        select: ['ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'RESPONSIBLE_ID', 'CREATED_BY',
          'GROUP_ID', 'PRIORITY', 'ACCOMPLICES', 'AUDITORS', 'DEADLINE'],
        start,
      });
      const result = isRecord(response.result) ? response.result : {};

      if (!Array.isArray(result.tasks)) {
        throw new TrackerError('tracker_rest_error', 'Облако не вернуло список задач', 502);
      }

      for (const raw of result.tasks) {
        const mapped = task(raw, (await accountIdentity()).userId);

        rows.set(Number(mapped.id), mapped);
      }

      const next = response.next;

      if (next === undefined || next === null) {
        break;
      }

      start = Number(next);

      if (!Number.isSafeInteger(start) || start < 0 || visited.has(start)) {
        throw new TrackerError('tracker_rest_error', 'Некорректная пагинация облака', 502);
      }
    } while (true);

    return [...rows.values()];
  }

  return {
    id: 'grigdesk-b24',
    capabilities: {
      ...NO_TRACKER_CAPABILITIES,
      create: true,
      complete: true,
      users: true,
      projects: true,
    },
    isConfigured: () => {
      try {
        credentials();

        return true;
      } catch {
        return false;
      }
    },
    accountIdentity,
    testAuth: async () => {
      try {
        return { ok: true, userId: Number((await accountIdentity()).userId) };
      } catch {
        return { ok: false, error: 'Не удалось проверить подключение облачного трекера' };
      }
    },
    listTasks: async () => list({ RESPONSIBLE_ID: (await accountIdentity()).userId }),
    taskDetail: async (id) => {
      const response = await rest('tasks.task.get', { taskId: id });

      return task(isRecord(response.result) ? response.result.task : null,
        (await accountIdentity()).userId);
    },
    getDashboard: async () => {
      const { userId } = await accountIdentity();
      const tasks = await list({ RESPONSIBLE_ID: userId });
      const created = await list({ CREATED_BY: userId });
      const accomplice = await list({ ACCOMPLICE: userId });
      const auditor = await list({ AUDITOR: userId });

      return {
        userId,
        tasks: tasks.filter((entry) => Number(entry.status) !== 4),
        toReview: tasks.filter((entry) => Number(entry.status) === 4),
        created,
        accomplice,
        auditor,
        widgets: [],
      };
    },
    sourceUrl: async (id) => {
      const { baseUrl, userId } = await accountIdentity();

      return `${baseUrl}/company/personal/user/${userId}/tasks/task/view/${id}/`;
    },
    probeTaskNumber: async (id) => {
      try {
        await rest('tasks.task.get', { taskId: id });

        return 'exists';
      } catch (error) {
        return error instanceof TrackerError && error.code === 'task_not_found' ? 'absent' : 'unknown';
      }
    },
    createTask: async (input) => {
      const fields: TaskData = { TITLE: input.title };
      const names = {
        description: 'DESCRIPTION',
        responsibleId: 'RESPONSIBLE_ID',
        groupId: 'GROUP_ID',
        priority: 'PRIORITY',
      };

      for (const [key, target] of Object.entries(names)) {
        if (Object.hasOwn(input, key)) {
          fields[target] = input[key];
        }
      }

      const response = await rest('tasks.task.add', { fields });
      const created = task(isRecord(response.result) ? response.result.task : null, null);

      return { ok: true, id: created.id };
    },
    completeTask: async (id) => {
      await rest('tasks.task.complete', { taskId: id });

      return { ok: true };
    },
    findUsers: async (query) => {
      const response = await rest('user.get', { FILTER: { FIND: query } });

      if (!Array.isArray(response.result)) {
        throw new TrackerError('tracker_rest_error', 'Облако не вернуло пользователей', 502);
      }

      return response.result.filter(isRecord).map((user) => ({
        id: Number(user.ID),
        name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' '),
      }));
    },
    listGroups: async () => {
      const response = await rest('sonet_group.get');

      if (!Array.isArray(response.result)) {
        throw new TrackerError('tracker_rest_error', 'Облако не вернуло проекты', 502);
      }

      return response.result.filter(isRecord).map((group) => ({ id: Number(group.ID), name: group.NAME }));
    },
  };
}
