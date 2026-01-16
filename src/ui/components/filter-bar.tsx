import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

export function FilterBar({
  query,
  onChange,
  onSubmit,
}: {
  query: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <Text>/</Text>
      <TextInput value={query} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
