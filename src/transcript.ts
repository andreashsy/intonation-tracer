// Shows a phrase's transcript (and translation) where the phrase is played:
// the player, Practice and the library row (M1 spec §7.1).

export interface HasTranscript {
  transcript?: string;
  translation?: string;
  lang?: string;
}

/** Fills `el` with the transcript and translation; hides it when there's no transcript. */
export function showTranscript(el: HTMLElement, p: HasTranscript | null | undefined): void {
  el.replaceChildren();
  el.removeAttribute('lang');
  el.hidden = !p?.transcript;
  if (!p?.transcript) return;
  const said = document.createElement('span');
  said.className = 'said';
  said.textContent = p.transcript;
  if (p.lang) said.lang = p.lang;
  el.append(said);
  if (p.translation) {
    const t = document.createElement('span');
    t.className = 'translation';
    t.textContent = p.translation;
    el.append(t);
  }
}
