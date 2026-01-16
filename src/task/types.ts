export type TaskProvider = 'linear' | 'github';

export type Task = {
  id: string;
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
  owner?: string;
  repo?: string;
  number?: number;
};
