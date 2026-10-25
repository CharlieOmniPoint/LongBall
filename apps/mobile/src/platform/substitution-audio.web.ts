let context: AudioContext | null = null;
const tones = new Map<OscillatorNode, string>();

/** Browser autoplay rules require the Manager to press Enable audio or Test sound first. */
export async function prepareSubstitutionAudio(): Promise<void> {
  const Audio = globalThis.AudioContext;
  if (!Audio) throw new Error('This browser cannot play the substitution tone. The visual countdown remains available.');
  if (!context || context.state === 'closed') context = new Audio();
  await context.resume();
  if (context.state !== 'running') throw new Error('Audio is paused by the browser. Press Test sound while this tab is open.');
}
export async function playSubstitutionAudio(volume: number, owner = 'default'): Promise<void> {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Choose a volume from 0 to 100%.');
  if (volume === 0) return;
  if (!context || context.state !== 'running') throw new Error('Press Enable audio for this device before using substitution sounds.');
  const at = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(660, at);
  oscillator.frequency.setValueAtTime(880, at + 0.18);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume * 0.35, at + 0.015);
  gain.gain.setValueAtTime(volume * 0.35, at + 0.34);
  gain.gain.linearRampToValueAtTime(0, at + 0.38);
  oscillator.connect(gain); gain.connect(context.destination);
  tones.set(oscillator, owner);
  oscillator.onended = () => { tones.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(at); oscillator.stop(at + 0.4);
}
export function stopSubstitutionAudio(owner = 'default'): void {
  for (const [tone, toneOwner] of tones) { if (toneOwner === owner) { try { tone.stop(); } catch { /* Already ended. */ } tones.delete(tone); } }
}
export const substitutionAudioCapability = 'Keep this browser tab open and press Enable audio for this device. Background tabs, lock screens and browser autoplay can silence alerts; the countdown stays available.';
