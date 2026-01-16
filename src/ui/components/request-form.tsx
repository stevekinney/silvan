import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

export function RequestForm({
  step,
  title,
  description,
  onTitleChange,
  onDescriptionChange,
  onSubmit,
}: {
  step: 'title' | 'description';
  title: string;
  description: string;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text color="gray">New task request (press Esc to cancel)</Text>
      {step === 'title' ? (
        <Box flexDirection="row" gap={1}>
          <Text>Title:</Text>
          <TextInput value={title} onChange={onTitleChange} onSubmit={onSubmit} />
        </Box>
      ) : (
        <Box flexDirection="row" gap={1}>
          <Text>Description:</Text>
          <TextInput
            value={description}
            onChange={onDescriptionChange}
            onSubmit={onSubmit}
          />
        </Box>
      )}
      <Text color="gray">
        {step === 'title' ? 'Enter to confirm title.' : 'Enter to enqueue request.'}
      </Text>
      <Text color="gray">Esc to cancel</Text>
    </Box>
  );
}
