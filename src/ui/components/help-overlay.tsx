import { Box, Text } from 'ink';
import React from 'react';

export function HelpOverlay(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text>Keybindings</Text>
      <Text color="gray">j/k or ↑/↓: move selection</Text>
      <Text color="gray">Enter: focus details (narrow view)</Text>
      <Text color="gray">b: back</Text>
      <Text color="gray">/: filter runs</Text>
      <Text color="gray">1-5: open filters (status/phase/convergence/provider/repo)</Text>
      <Text color="gray">6-7: open filters (task/pr)</Text>
      <Text color="gray">a: toggle attention mode</Text>
      <Text color="gray">g: toggle repo grouping</Text>
      <Text color="gray">s: cycle sort (updated/started/duration)</Text>
      <Text color="gray">v: toggle artifacts</Text>
      <Text color="gray">t: toggle step history</Text>
      <Text color="gray">c: clear filters</Text>
      <Text color="gray">n: new task request</Text>
      <Text color="gray">l: load more runs</Text>
      <Text color="gray">r: refresh from disk</Text>
      <Text color="gray">?: toggle help</Text>
      <Text color="gray">q: quit</Text>
    </Box>
  );
}
