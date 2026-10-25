import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = { gains: [] as number[], oscillators: 0, stops: 0, resumes: 0, blocked: false };
class AudioMock {
  state = 'suspended'; currentTime = 5; destination = {};
  async resume() { probe.resumes++; if (!probe.blocked) this.state = 'running'; }
  createOscillator() {
    probe.oscillators++;
    return { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: () => { probe.stops++; }, onended: null };
  }
  createGain() {
    const capture = (value: number) => { probe.gains.push(value); };
    return { gain: { setValueAtTime: capture, linearRampToValueAtTime: capture }, connect: vi.fn(), disconnect: vi.fn() };
  }
}
beforeEach(() => { vi.resetModules(); probe.gains = []; probe.oscillators = 0; probe.stops = 0; probe.resumes = 0; probe.blocked = false; vi.stubGlobal('AudioContext', AudioMock); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('foreground browser substitution audio adapter (mock audio graph; not speaker delivery)', () => {
  it('requires explicit preparation, respects selected amplitude/mute and stops owned tones', async () => {
    const audio = await import('./substitution-audio.web');
    await expect(audio.playSubstitutionAudio(0.5)).rejects.toThrow('Enable audio');
    expect(probe.oscillators).toBe(0);
    await audio.prepareSubstitutionAudio();
    await audio.playSubstitutionAudio(0.5);
    expect(probe.resumes).toBe(1);
    expect(Math.max(...probe.gains)).toBeCloseTo(0.175);
    await audio.playSubstitutionAudio(0);
    expect(probe.oscillators).toBe(1);
    audio.stopSubstitutionAudio();
    expect(probe.stops).toBe(2); // scheduled ending plus immediate cancellation
    await expect(audio.playSubstitutionAudio(1.01)).rejects.toThrow('0 to 100');
  });
  it('reports autoplay or missing API limitations without creating a fallback alarm', async () => {
    probe.blocked = true;
    const audio = await import('./substitution-audio.web');
    await expect(audio.prepareSubstitutionAudio()).rejects.toThrow('paused by the browser');
    expect(probe.oscillators).toBe(0);
    vi.stubGlobal('AudioContext', undefined);
    await expect(audio.prepareSubstitutionAudio()).rejects.toThrow('cannot play');
  });
  it('keeps independent planner owners from cancelling another match tone', async () => {
    const audio = await import('./substitution-audio.web');
    await audio.prepareSubstitutionAudio();
    await audio.playSubstitutionAudio(0.4, 'connected-match');
    const scheduledStops = probe.stops;
    audio.stopSubstitutionAudio('inactive-local-match');
    expect(probe.stops).toBe(scheduledStops);
    audio.stopSubstitutionAudio('connected-match');
    expect(probe.stops).toBe(scheduledStops + 1);
  });
});
