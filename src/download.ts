// Saving files to the user's device (library downloads, M1 spec §7).

/** Makes a name safe for a file name on every OS. */
export function safeFileName(name: string, fallback = 'phrase'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

/** File extension for a media type, e.g. "video/mp4" → "mp4". */
export function extensionFor(type: string, fallbackName = ''): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(fallbackName)?.[1];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  };
  return map[type] ?? 'bin';
}

/** Hands a Blob to the browser as a download. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
