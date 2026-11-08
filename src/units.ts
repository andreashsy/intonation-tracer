// The chart axis unit (pitch-axis spec §3): shared by all charts and remembered in this browser.

import type { AxisUnit } from './pitchAxis.ts';

const KEY = 'intonation-tracer.axisUnit';
const listeners = new Set<(u: AxisUnit) => void>();

function load(): AxisUnit {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'hz' || v === 'notes' ? v : 'st';
  } catch {
    return 'st';
  }
}

let unit: AxisUnit = load();

export function getUnit(): AxisUnit {
  return unit;
}

export function setUnit(u: AxisUnit): void {
  if (u === unit) return;
  unit = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    // not remembered; fine
  }
  for (const l of listeners) l(u);
}

export function onUnitChange(fn: (u: AxisUnit) => void): void {
  listeners.add(fn);
}

/** Wires every `select.axis-unit` on the page to the shared setting. */
export function bindUnitMenus(): void {
  const menus = [...document.querySelectorAll<HTMLSelectElement>('select.axis-unit')];
  for (const m of menus) {
    m.value = unit;
    m.addEventListener('change', () => setUnit(m.value as AxisUnit));
  }
  onUnitChange((u) => {
    for (const m of menus) m.value = u;
  });
}
