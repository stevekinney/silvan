import { render } from 'ink';

import type { EventBus } from '../events/bus';
import type { StateStore } from '../state/store';
import { Dashboard } from './dashboard';

export function mountDashboard(bus: EventBus, _state: StateStore): void {
  render(<Dashboard bus={bus} />, { exitOnCtrlC: true });
}
