import { render } from 'ink';

import type { EventBus } from '../events/bus';
import type { StateStore } from '../state/store';
import { Dashboard } from './dashboard';
import { startPrSnapshotPoller } from './poller';

export function mountDashboard(bus: EventBus, state: StateStore): Promise<void> {
  const instance = render(<Dashboard bus={bus} stateStore={state} />, {
    exitOnCtrlC: true,
  });
  return instance.waitUntilExit();
}

export { startPrSnapshotPoller };
