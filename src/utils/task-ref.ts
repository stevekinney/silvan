export type LinearTaskMatch = {
  taskId: string;
  teamKey: string;
  taskNumber: number;
  source: 'branch';
};

const linearPattern = /\b([A-Z]{2,10})-(\d+)\b/;

export function extractLinearTaskFromBranch(branch: string): LinearTaskMatch | null {
  const match = branch.match(linearPattern);
  if (!match) {
    return null;
  }
  const teamKey = match[1]!;
  const numberStr = match[2]!;
  return {
    taskId: `${teamKey}-${numberStr}`,
    teamKey,
    taskNumber: Number(numberStr),
    source: 'branch',
  };
}
