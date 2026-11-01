import type {
  TrackerCapabilities,
  TrackerSettingsSchema,
  TrackerWidget,
} from './capabilities.ts';

export type TaskData = Record<string, unknown>;
export type TaskRef = { trackerId: string; id: string };
export type TaskPresence = 'exists' | 'absent' | 'unknown';
export type TrackerIdentity = { baseUrl: string; userId: string };

export interface DriverManifest {
  id: string;
  name: string;
  version: string;
  contract: 1;
  settings: TrackerSettingsSchema;
}

export interface TrackerHost {
  fetch?: typeof fetch;
  credentials: { read(): TaskData | null };
  dataDir: string;
  cookiePath: string;
  serial<T>(operation: () => Promise<T>): Promise<T>;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface TrackerDashboard extends TaskData {
  tasks: TaskData[];
  toReview: TaskData[];
  created: TaskData[];
  accomplice?: TaskData[];
  auditor?: TaskData[];
  widgets: TrackerWidget[];
  compatibility?: TaskData;
}

export interface TaskTracker {
  id: string;
  capabilities: TrackerCapabilities;
  isConfigured(): boolean;
  accountIdentity(): Promise<TrackerIdentity | null>;
  testAuth(): Promise<{
    ok: boolean;
    userId?: number | null;
    error?: string;
  }>;
  listTasks(): Promise<TaskData[]>;
  taskDetail(id: string): Promise<unknown>;
  getDashboard(): Promise<TrackerDashboard>;
  sourceUrl(id: string): Promise<string> | string;
  probeTaskNumber(id: string): Promise<TaskPresence>;
  taskPageData?(id: string): Promise<unknown>;
  createTask?(input: TaskData): Promise<unknown>;
  updateTask?(id: string, input: unknown): Promise<unknown>;
  addComment?(id: string, text: unknown): Promise<unknown>;
  timer?(action: string, id: string): Promise<unknown>;
  completeTask?(id: string): Promise<unknown>;
  deleteTask?(id: string): Promise<{ ok: boolean }>;
  renewTask?(id: string): Promise<unknown>;
  findUsers?(query: string): Promise<unknown>;
  listGroups?(): Promise<unknown>;
  dispose?(): Promise<void>;
}

export type TrackerFactory = (host: TrackerHost) => TaskTracker | Promise<TaskTracker>;

export class TrackerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
