export function calculatePageSize(
  terminalRows: number,
  options?: {
    headerHeight?: number;
    footerHeight?: number;
    detailPanelHeight?: number;
    min?: number;
  },
): number {
  const headerHeight = options?.headerHeight ?? 4;
  const footerHeight = options?.footerHeight ?? 3;
  const detailPanelHeight = options?.detailPanelHeight ?? 0;
  const min = options?.min ?? 5;
  const available = terminalRows - headerHeight - footerHeight - detailPanelHeight;
  return Math.max(min, available);
}
