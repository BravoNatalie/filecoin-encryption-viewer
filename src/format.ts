const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Human-readable byte size in decimal units (as Finder shows them), e.g. "812 B", "2.0 MB", "12 MB". */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}
