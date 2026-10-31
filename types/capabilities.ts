export const TRACKER_CONTRACT_VERSION = 1;

export interface TrackerCapabilities {
  create: boolean;
  timer: boolean;
  comments: boolean;
  attachments: boolean;
  widgets: boolean;
  editing: boolean;
  complete: boolean;
  renew: boolean;
  users: boolean;
  projects: boolean;
}

export type TrackerLabel = { key: string; params?: Record<string, string | number> } | { text: string };
export type TrackerNumberFormat = 'count' | 'duration' | 'decimal';

export interface TrackerWidgetValue {
  id: string;
  label: TrackerLabel;
  value: number;
  format: TrackerNumberFormat;
  delta?: number;
  progress?: { value: number; max: number };
  secondaryItems?: Array<Omit<TrackerWidgetValue, 'secondaryItems' | 'progress'>>;
}

export interface TrackerChartPeriod {
  labels: string[];
  series: Array<{
    id: string;
    label: TrackerLabel;
    values: number[];
    format: TrackerNumberFormat;
  }>;
}

export type TrackerWidget = {
  id: string;
  kind: 'kpi';
  title: TrackerLabel;
  items: TrackerWidgetValue[];
} | {
  id: string;
  kind: 'chart';
  title: TrackerLabel;
  periods: Partial<Record<'day' | 'week' | 'month', TrackerChartPeriod>>;
};

export interface TrackerSettingsField {
  type: 'string' | 'boolean' | 'number';
  label?: TrackerLabel;
  secret?: boolean;
  required?: boolean;
}

export type TrackerSettingsSchema = Record<string, TrackerSettingsField>;

export interface TrackerDescriptor {
  id: string;
  name: string;
  version: string;
  contract: number;
  status: 'active' | 'available' | 'unavailable' | 'restartRequired';
  configured: boolean;
  capabilities: TrackerCapabilities;
  schema: TrackerSettingsSchema;
  reason?: string;
}

export interface TrackerCatalog {
  drivers: TrackerDescriptor[];
  activeIds: string[];
  externalId: string | null;
  revision: number;
}

export const NO_TRACKER_CAPABILITIES: TrackerCapabilities = {
  create: false,
  timer: false,
  comments: false,
  attachments: false,
  widgets: false,
  editing: false,
  complete: false,
  renew: false,
  users: false,
  projects: false,
};
