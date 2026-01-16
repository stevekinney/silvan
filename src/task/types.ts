export type TaskProvider = 'linear' | 'github' | 'local';

export type Task = {
  id: string;
  key?: string;
  provider: TaskProvider;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  url?: string;
  labels: string[];
  assignee?: string;
  state?: string;
  metadata?: Record<string, unknown>;
};

export type TaskRef = {
  provider: TaskProvider;
  id: string;
  raw: string;
  key?: string;
  mode?: 'id' | 'title';
  owner?: string;
  repo?: string;
  number?: number;
};
