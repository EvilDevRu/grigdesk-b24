import { NO_TRACKER_CAPABILITIES } from '../types/capabilities.ts';
import { PasswordAuth } from './auth.ts';
import { comment } from './comments.ts';
import { isRecord, redactSecrets } from './objects.ts';
import { describeStatus } from './status.ts';
import { taskUpdateFields } from './taskFields.ts';
import { TrackerError } from '../types/contract.ts';
import type { TaskData, TaskTracker, TrackerHost, TrackerIdentity } from '../types/contract.ts';

// Только явный отказ нового модуля разрешает запасной способ завершения.
// Исходная ошибка сохраняет обычную редактированную диагностику REST.
class CompletionDeniedError extends TrackerError {
}

/**
 * REST использует явно выбранный токен либо самостоятельную сессию портала.
 * Реквизиты другого режима не участвуют в запросах и кеше идентичности.
 */
export function createStockTracker(host: TrackerHost, transport: typeof fetch = fetch): TaskTracker {
  let passwordAuth: { signature: string; value: PasswordAuth } | null = null;
  let identity: { signature: string; value: TrackerIdentity } | null = null;

  /**
   * Origin проверяется перед каждым обращением, включая смену реквизитов.
   * Реквизиты URL, путь, query и небезопасная схема не становятся адресом REST.
   */
  function credentials() {
    const values = host.credentials.read();
    // Адрес без схемы — это имя портала: https подставляется сам, а не требует человека.
    const typed = String(values?.baseUrl ?? '').trim().replace(/\/+$/u, '');
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(typed) ? typed : `https://${typed}`;
    let url: URL;

    try {
      url = new URL(withScheme);
    } catch {
      throw new TrackerError('tracker_unavailable', 'Укажите адрес портала');
    }

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/') {
      throw new TrackerError('tracker_unavailable', 'Укажите HTTPS origin портала');
    }

    if (values?.authMode === 'token' && typeof values.accessToken === 'string'
      && values.accessToken.trim()) {
      return {
        origin: url.origin,
        authMode: 'token' as const,
        accessToken: values.accessToken,
      };
    }

    if (values?.authMode === 'password' && typeof values.login === 'string' && values.login.trim()
      && typeof values.password === 'string' && values.password.trim()) {
      return {
        origin: url.origin,
        authMode: 'password' as const,
        login: values.login,
        password: values.password,
      };
    }

    throw new TrackerError('tracker_unavailable', 'Выберите способ подключения и заполните его реквизиты');
  }

  /**
   * Текст ошибки портала сохраняется после удаления секретов выбранного режима.
   * Сетевой срок ограничен и тем же signal управляет транспорт фикстуры и настоящий fetch.
   */
  async function rest(method: string, fields: TaskData = {}): Promise<TaskData> {
    const creds = credentials();
    const signature = JSON.stringify(creds);

    if (passwordAuth?.signature !== signature) {
      passwordAuth = null;
    }

    if (creds.authMode === 'password' && !passwordAuth) {
      passwordAuth = { signature, value: new PasswordAuth(creds, host.cookiePath, transport) };
    }

    const auth = passwordAuth?.value;

    try {
      const response = creds.authMode === 'password'
        ? await host.serial(() => auth!.request(method, fields))
        : await transport(`${creds.origin}/rest/${method}`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, auth: creds.accessToken }),
        });
      const body: unknown = await response.json();

      if (isRecord(body) && (body.error || body.error_description)) {
        const raw = typeof body.error_description === 'string' && body.error_description.trim()
          ? body.error_description : String(body.error || 'Портал отклонил запрос');
        const message = creds.authMode === 'password' ? auth!.redact(raw)
          : redactSecrets(raw, [creds.accessToken]);
        const missing = body.error === 'TASK_NOT_FOUND' || body.error === 'ERROR_TASK_NOT_FOUND';
        const denied = /^(ACCESS_DENIED|ERROR_ACCESS_DENIED|insufficient_scope)$/iu.test(String(body.error))
          || response.status === 403;

        const completionDenied = method === 'tasks.task.complete'
          && [400, 403].includes(response.status)
          && (String(body.error) === '0' || /Действие над задачей не разрешено/iu.test(raw));
        const Failure = completionDenied ? CompletionDeniedError : TrackerError;

        throw new Failure(missing ? 'task_not_found' : 'tracker_rest_error', message,
          missing ? 404 : denied ? 403 : 502);
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
   * Список задач содержит строковые подписи проекта и исполнителя для доски.
   * REST возвращает их объектами; детали карточки сохраняют исходные объекты отдельно.
   */
  function boardTask(value: TaskData): TaskData {
    const group = isRecord(value.group) ? value.group.name : value.group;
    const responsible = isRecord(value.responsible) ? value.responsible.name : value.responsible;

    return {
      ...value,
      group: typeof group === 'string' ? group : '',
      responsible: typeof responsible === 'string' ? responsible : '',
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
        const mapped = boardTask(task(raw, (await accountIdentity()).userId));

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

  /**
   * Читает все страницы обсуждения по указателю next, не угадывая размер страницы портала.
   * Ошибка выходит только через чтение обсуждения: основные данные карточки запрашиваются отдельно.
   */
  async function taskPageData(id: string): Promise<TaskData> {
    const rows = new Map<number, TaskData>();
    const visited = new Set<number>();
    let start = 0;

    do {
      visited.add(start);

      const response = await rest('task.commentitem.getlist', {
        TASKID: id,
        ORDER: { ID: 'asc' },
        start,
      });

      if (!Array.isArray(response.result)) {
        throw new TrackerError('tracker_rest_error', 'Портал не вернул список комментариев', 502);
      }

      for (const raw of response.result) {
        const mapped = comment(raw);

        rows.set(Number(mapped.mid), mapped);
      }

      if (response.next === undefined || response.next === null) {
        break;
      }

      start = Number(response.next);

      if (!Number.isSafeInteger(start) || start < 0 || visited.has(start)) {
        throw new TrackerError('tracker_rest_error', 'Некорректная пагинация комментариев', 502);
      }
    } while (true);

    return { attachments: [], comments: [...rows.values()] };
  }

  /**
   * Отправляет только проверенные изменения; исходную задачу для слияния не перечитывает.
   * Транспорт обновляет сессию, но не повторяет отказы прав и неопределённые сетевые сбои.
   */
  async function updateTask(id: string, input: unknown): Promise<TaskData> {
    const fields = taskUpdateFields(input);

    const response = await rest('tasks.task.update', { taskId: id, fields });

    if (response.result !== true && (!isRecord(response.result) || !isRecord(response.result.task))) {
      throw new TrackerError('tracker_rest_error', 'Портал не подтвердил изменение задачи', 502);
    }

    return { ok: true, id: Number(id) };
  }

  /**
   * Пустой текст отклоняется до сети, а значимые пробелы и переносы сохраняются.
   * Добавление использует общий REST-транспорт и возвращает номер нового комментария.
   */
  async function addComment(id: string, text: unknown): Promise<TaskData> {
    if (typeof text !== 'string' || !text.trim()) {
      throw new TrackerError('tracker_bad_request', 'Пустой комментарий');
    }

    const response = await rest('task.commentitem.add', { TASKID: id, FIELDS: { POST_MESSAGE: text } });
    const commentId = typeof response.result === 'string' || typeof response.result === 'number'
      ? Number(response.result) : NaN;

    if (!Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new TrackerError('tracker_rest_error', 'Портал не вернул номер комментария', 502);
    }

    return { ok: true, commentId };
  }

  /**
   * Новый модуль иногда запрещает complete даже исполнителю с правом менять статус.
   * Единственный запасной запрос завершает через STATUS=5; его отказ сохраняет исходную ошибку.
   */
  async function completeTask(id: string): Promise<{ ok: boolean }> {
    try {
      await rest('tasks.task.complete', { taskId: id });
    } catch (error) {
      if (!(error instanceof CompletionDeniedError)) {
        throw error;
      }

      try {
        const response = await rest('tasks.task.update', { taskId: id, fields: { STATUS: 5 } });

        if (response.result !== true && (!isRecord(response.result) || !isRecord(response.result.task))) {
          throw new TrackerError('tracker_rest_error', 'Портал не подтвердил завершение задачи', 502);
        }
      } catch {
        throw error;
      }
    }

    return { ok: true };
  }

  /**
   * Удаление подтверждается только явным result.task=true от портала.
   * Некорректный результат не считается успешной необратимой операцией.
   */
  async function deleteTask(id: string): Promise<{ ok: boolean }> {
    const response = await rest('tasks.task.delete', { taskId: id });

    if (!isRecord(response.result) || response.result.task !== true) {
      throw new TrackerError('tracker_rest_error', 'Портал не подтвердил удаление задачи', 502);
    }

    return { ok: true };
  }

  return {
    id: 'grigdesk-b24',
    capabilities: {
      ...NO_TRACKER_CAPABILITIES,
      create: true,
      comments: true,
      editing: true,
      complete: true,
      delete: true,
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
    taskPageData,
    updateTask,
    completeTask,
    deleteTask,
    addComment,
    testAuth: async () => {
      try {
        return { ok: true, userId: Number((await accountIdentity()).userId) };
      } catch (error) {
        return { ok: false, error: error instanceof TrackerError
          ? error.message : 'Не удалось проверить подключение облачного трекера' };
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
