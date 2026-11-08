// Rough speed check for the analysis budget (spec §6.5: 60 s in < 2 s on a mid-range laptop).
// Run with: npm run bench
import { analyzePcm } from '../src/analyze.ts';
import { glide, SR } from './helpers.ts';

const seconds = 60;
// Alternate a voiced glide and silence, roughly like speech with pauses.
const pcm = new Float32Array(seconds * SR);
for (let s = 0; s < seconds; s += 2) pcm.set(glide(120, 220, 1.2), s * SR);

analyzePcm(pcm.subarray(0, SR * 2), SR); // warm up the JIT
const t0 = performance.now();
const track = analyzePcm(pcm, SR);
const ms = performance.now() - t0;
const voiced = track.f0.filter((x) => !Number.isNaN(x)).length;
console.log(`Analyzed ${seconds} s in ${ms.toFixed(0)} ms (${track.f0.length} frames, ${voiced} voiced).`);
console.log(ms < 2000 ? 'Within the 2 s budget on this machine.' : 'Over the 2 s budget on this machine.');
