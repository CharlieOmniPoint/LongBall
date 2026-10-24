import { nativeCapabilities } from './native-capabilities';
let currentOwner: string | null = null;

/** Explicit user action prepares foreground audio. System mute/Focus is never overridden. */
export async function prepareSubstitutionAudio(): Promise<void> {
  if (!nativeCapabilities?.playSubstitutionTone || !nativeCapabilities.stopSubstitutionTone) throw new Error('This native client needs an updated build for adjustable substitution audio. The visual countdown remains available.');
}
export async function playSubstitutionAudio(volume: number, owner = 'default'): Promise<void> {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Choose a volume from 0 to 100%.');
  if (volume === 0) return;
  await prepareSubstitutionAudio();
  if (!nativeCapabilities!.playSubstitutionTone!(volume)) throw new Error('The substitution tone could not be played. Keep the visual countdown open.');
  currentOwner = owner;
}
export function stopSubstitutionAudio(owner = 'default'): void {
  if (currentOwner !== owner) return;
  nativeCapabilities?.stopSubstitutionTone?.();
  currentOwner = null;
}
export const substitutionAudioCapability = 'Foreground audio uses the selected volume and device media volume. Silent mode, Focus, background delivery and tablet/phone speakers require native device checks.';
