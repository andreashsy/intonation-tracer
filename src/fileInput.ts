// Drop zone and file picker (spec §2, §5).

const EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'mp4', 'm4v', 'webm', 'mov'];

export function looksLikeMedia(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS.includes(ext);
}

export function setupFileInput(zone: HTMLElement, input: HTMLInputElement, onFile: (file: File) => void): void {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    if (file) onFile(file);
  });

  zone.addEventListener('click', (e) => {
    // The "choose one" label already opens the picker; don't open it twice.
    if ((e.target as HTMLElement).closest('label, input, button')) return;
    input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.target !== zone) return; // let the Record button handle its own keys
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    const file = e.dataTransfer?.files[0];
    if (file) onFile(file);
  });

  // Dropping a file anywhere else shouldn't navigate away from the app.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
