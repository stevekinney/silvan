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
      <Text color="gray">r: refresh from disk</Text>
      <Text color="gray">?: toggle help</Text>
      <Text color="gray">q: quit</Text>
    </Box>
  );
}
