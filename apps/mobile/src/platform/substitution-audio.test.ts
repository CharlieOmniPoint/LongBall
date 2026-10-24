import { beforeEach, describe, expect, it, vi } from 'vitest';
import { playSubstitutionAudio, prepareSubstitutionAudio, stopSubstitutionAudio } from './substitution-audio';
const bridge = vi.hoisted(() => ({ playSubstitutionTone: vi.fn(() => true), stopSubstitutionTone: vi.fn() }));
vi.mock('./native-capabilities', () => ({ nativeCapabilities: bridge }));
beforeEach(() => { vi.clearAllMocks(); bridge.playSubstitutionTone.mockReturnValue(true); });
describe('native foreground tone adapter (mock bridge; not speaker delivery)', () => {
  it('passes the chosen volume without letting an inactive planner stop another match', async () => {
    await prepareSubstitutionAudio();
    await playSubstitutionAudio(0.35, 'current-match');
    expect(bridge.playSubstitutionTone).toHaveBeenCalledExactlyOnceWith(0.35);
    stopSubstitutionAudio('other-match');
    expect(bridge.stopSubstitutionTone).not.toHaveBeenCalled();
    stopSubstitutionAudio('current-match');
    expect(bridge.stopSubstitutionTone).toHaveBeenCalledOnce();
  });
  it('keeps mute silent and reports invalid volume or native failure', async () => {
    await playSubstitutionAudio(0, 'muted');
    expect(bridge.playSubstitutionTone).not.toHaveBeenCalled();
    await expect(playSubstitutionAudio(NaN)).rejects.toThrow('0 to 100');
    bridge.playSubstitutionTone.mockReturnValue(false);
    await expect(playSubstitutionAudio(0.5)).rejects.toThrow('could not be played');
  });
});
