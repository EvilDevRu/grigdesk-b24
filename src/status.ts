// Семантика статусов задач Битрикса в терминах «что это значит и чей ход».
//
// Числовые коды статуса (Bitrix CTasks::STATE_*):
//   2 PENDING      — ждёт выполнения (назначена, ещё не начата)
//   3 IN_PROGRESS  — выполняется (начата; таймер при этом может НЕ идти)
//   4 SUPPOSEDLY_COMPLETED — ждёт контроля: ответственный сдал, ждёт приёмки ПОСТАНОВЩИКОМ
//   5 COMPLETED    — завершена
//   6 DEFERRED     — отложена
//   7 DECLINED     — отклонена
//
// Ключевой нюанс: при статусе 4 действие за ПОСТАНОВЩИКОМ (creator), а не за
// ответственным. Если ответственный — это я, то я уже всё сделал и жду приёмки.

export const STATUS = {
    NEW: 1,
    PENDING: 2,
    IN_PROGRESS: 3,
    REVIEW: 4,
    COMPLETED: 5,
    DEFERRED: 6,
    DECLINED: 7,
};

/**
 * Возвращает машинный вид статуса, понятную человеку подпись, расшифровку «чей ход»,
 * эмодзи-маркер для списка и признак «нужно моё действие».
 */
// Что нужно знать о задаче, чтобы назвать её состояние словами.
export interface TaskStatusFacts {
    status?: unknown;
    responsibleId?: unknown;
    creatorId?: unknown;
    timerRunning?: unknown;
}

export interface TaskStatusView {
    kind: string;
    label: string;
    hint: string;
    icon: string;
    actionable: boolean;
}

/**
 * Семантика статуса определяется в пакете по роли текущего пользователя.
 * Host получает готовое представление без знания числовых кодов Битрикса.
 */
export function describeStatus(t: TaskStatusFacts, myId: unknown): TaskStatusView {
    const me = Number(myId);
    const iAmResponsible = t.responsibleId != null && Number(t.responsibleId) === me;
    const iAmCreator = t.creatorId != null && Number(t.creatorId) === me;

    switch (Number(t.status)) {
        case STATUS.PENDING:
            return {
                kind: 'todo',
                label: 'Ждёт выполнения',
                hint: 'ещё не начата — твой ход',
                icon: '🟡',
                actionable: true,
            };

        case STATUS.IN_PROGRESS:
            return t.timerRunning
                ? {
                      kind: 'running',
                      label: 'В работе — таймер идёт',
                      hint: 'сейчас списывается время',
                      icon: '🟢',
                      actionable: true,
                  }
                : {
                      kind: 'in_progress',
                      label: 'В работе (таймер не идёт)',
                      hint: 'начата, но сейчас время не списывается',
                      icon: '🔵',
                      actionable: true,
                  };

        case STATUS.REVIEW:
            if (iAmResponsible && !iAmCreator) {
                return {
                    kind: 'await_acceptance',
                    label: 'Сдана — ждёт приёмки постановщиком',
                    hint: 'ты выполнил, действие за постановщиком — не твоё',
                    icon: '📤',
                    actionable: false,
                };
            }
            return {
                kind: 'my_review',
                label: 'Ждёт твоей приёмки',
                hint: 'ты постановщик — нужно принять или вернуть',
                icon: '🟣',
                actionable: true,
            };

        case STATUS.COMPLETED:
            return {
                kind: 'done',
                label: 'Завершена',
                hint: '',
                icon: '✔️',
                actionable: false,
            };
        case STATUS.DEFERRED:
            return {
                kind: 'deferred',
                label: 'Отложена',
                hint: '',
                icon: '💤',
                actionable: false,
            };
        case STATUS.DECLINED:
            return {
                kind: 'declined',
                label: 'Отклонена',
                hint: '',
                icon: '🚫',
                actionable: false,
            };
        default:
            return {
                kind: 'other',
                label: `статус ${t.status}`,
                hint: '',
                icon: '·',
                actionable: false,
            };
    }
}

/**
 * Краткая легенда статусов для подвала списка.
 */
export const STATUS_LEGEND =
    'Статусы: 🟡 ждёт (твой ход) · 🔵 в работе (начата, таймер не идёт) · ' +
    '🟢 таймер идёт сейчас · 📤 сдана, ждёт приёмки постановщика (не твоё) · 🟣 ждёт твоей приёмки';
