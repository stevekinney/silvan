import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

export function FilterPrompt({
  label,
  value,
  hint,
  onChange,
  onSubmit,
}: {
  label: string;
  value: string;
  hint: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text color="gray">{label}</Text>
      <Box flexDirection="row" gap={1}>
        <Text>{label}:</Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      <Text color="gray">{hint}</Text>
      <Text color="gray">Enter to apply • Esc to cancel</Text>
    </Box>
  );
}
