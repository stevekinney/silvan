import { render } from 'ink';

import type { Config } from '../config/schema';
import type { EventBus } from '../events/bus';
import type { StateStore } from '../state/store';
import { Dashboard } from './dashboard';
import { startPrSnapshotPoller } from './poller';

export function mountDashboard(
  bus: EventBus,
  state: StateStore,
  config: Config,
): Promise<void> {
  const instance = render(<Dashboard bus={bus} stateStore={state} config={config} />, {
    exitOnCtrlC: true,
  });
  return instance.waitUntilExit();
}

export { startPrSnapshotPoller };
