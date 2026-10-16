const LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP archive',
  'application/gzip': 'GZIP archive',
  'application/json': 'JSON',
  'image/jpeg': 'JPEG image',
  'image/png': 'PNG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
  'image/svg+xml': 'SVG image',
  'video/mp4': 'MP4 video',
  'video/webm': 'WebM video',
  'video/quicktime': 'QuickTime video',
  'audio/mpeg': 'MP3 audio',
  'audio/wav': 'WAV audio',
  'audio/ogg': 'Ogg audio',
  'text/plain': 'Text',
  'text/html': 'HTML page',
}

const FALLBACK_PREFIXES: [string, string][] = [
  ['image/', 'Image'],
  ['video/', 'Video'],
  ['audio/', 'Audio'],
]

export const UNKNOWN_FILE_TYPE = 'Unknown file type'

/** Friendly name for a sniffed MIME type; anything unrecognised is "Unknown file type". */
export function fileTypeLabel(contentType: string | undefined): string {
  if (!contentType) return UNKNOWN_FILE_TYPE
  const known = LABELS[contentType]
  if (known) return known
  return FALLBACK_PREFIXES.find(([prefix]) => contentType.startsWith(prefix))?.[1] ?? UNKNOWN_FILE_TYPE
}
