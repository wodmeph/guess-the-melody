import { describe, expect, it, vi } from 'vitest';
import { AudioWindowState, fillAudioWindow } from './audioWindow';
import type { Track } from './types';

function track(id: string): Track {
  return { id, title: `Track ${id}`, artist: 'Artist', audioUrl: `https://example.test/${id}.mp3` };
}

function cached(value: Track): Track {
  return { ...value, audioUrl: `/api/audio/${value.id}` };
}

describe('AudioWindowState', () => {
  it('moves the cursor forward and skips tracks that are already prepared', async () => {
    const state = new AudioWindowState();
    const tracks = [track('1'), track('2'), track('3')];
    state.addEntry(cached(tracks[0]), tracks[0].audioUrl);
    const prepare = vi.fn(async (value: Track) => cached(value));

    await fillAudioWindow({ state, tracks, targetSize: 2, prepare });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(tracks[1]);
    expect(state.candidates().map((value) => value.id)).toEqual(['1', '2']);
  });

  it('skips failed tracks and keeps filling from the pool', async () => {
    const state = new AudioWindowState();
    const tracks = [track('1'), track('2')];
    const prepare = vi.fn(async (value: Track) => (value.id === '1' ? undefined : cached(value)));

    await fillAudioWindow({ state, tracks, targetSize: 1, prepare });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(state.candidates().map((value) => value.id)).toEqual(['2']);
  });

  it('stops at the target size and does not advance past the pool', async () => {
    const state = new AudioWindowState();
    const tracks = [track('1'), track('2')];
    const prepare = vi.fn(async (value: Track) => cached(value));

    await fillAudioWindow({ state, tracks, targetSize: 5, prepare });
    await fillAudioWindow({ state, tracks, targetSize: 5, prepare });

    expect(state.size()).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('does not add duplicates and reports the orphaned cache entry', async () => {
    const state = new AudioWindowState();
    const first = track('1');
    state.addEntry(cached(first), first.audioUrl);
    const duplicate = { ...cached(track('2')), id: first.id };
    const onOrphan = vi.fn();

    await fillAudioWindow({
      state,
      tracks: [track('2')],
      targetSize: 2,
      prepare: async () => duplicate,
      onOrphan
    });

    expect(onOrphan).toHaveBeenCalledWith(duplicate);
    expect(state.size()).toBe(1);
  });

  it('takes the current track out of the window and releases it later', () => {
    const state = new AudioWindowState();
    const first = track('1');
    state.addEntry(cached(first), first.audioUrl);
    const current = state.candidates()[0];

    expect(state.takeCurrent(current)).toBe(true);
    expect(state.candidates()).toEqual([]);
    expect(state.current()?.track.id).toBe('1');
    expect(state.isLocalUrlInUse('/api/audio/1')).toBe(true);

    expect(state.releaseCurrent()?.track.id).toBe('1');
    expect(state.current()).toBeUndefined();
    expect(state.isLocalUrlInUse('/api/audio/1')).toBe(false);
  });

  it('invalidates older generations on reset', () => {
    const state = new AudioWindowState();
    const generation = state.generationValue();
    state.addEntry(cached(track('1')), track('1').audioUrl);

    state.reset();

    expect(state.isGenerationCurrent(generation)).toBe(false);
    expect(state.size()).toBe(0);
    expect(state.generationValue()).toBeGreaterThan(generation);
  });

  it('uses globally increasing generations across rooms', () => {
    const first = new AudioWindowState();
    const second = new AudioWindowState();

    expect(second.generationValue()).toBeGreaterThan(first.generationValue());
  });

  it('reports the prepared track as an orphan when the window is reset mid-download', async () => {
    const state = new AudioWindowState();
    const onOrphan = vi.fn();
    const prepare = vi.fn(async (value: Track) => {
      state.reset();
      return cached(value);
    });

    await fillAudioWindow({ state, tracks: [track('1')], targetSize: 1, prepare, onOrphan });

    expect(onOrphan).toHaveBeenCalledTimes(1);
    expect(state.size()).toBe(0);
  });
});
