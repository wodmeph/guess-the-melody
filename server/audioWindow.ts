import type { Track } from './types';

export type AudioWindowEntry = {
  track: Track;
  upstreamUrl: string;
};

let generationCounter = 0;

function nextGeneration(): number {
  generationCounter += 1;
  return generationCounter;
}

export class AudioWindowState {
  private entries: AudioWindowEntry[] = [];
  private cursor = 0;
  private currentEntry: AudioWindowEntry | undefined;
  private generation = nextGeneration();

  generationValue(): number {
    return this.generation;
  }

  isGenerationCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  size(): number {
    return this.entries.length;
  }

  current(): AudioWindowEntry | undefined {
    return this.currentEntry;
  }

  candidates(): Track[] {
    return this.entries.map((entry) => entry.track);
  }

  isPreparedOrActive(track: Track): boolean {
    if (this.currentEntry?.upstreamUrl === track.audioUrl) {
      return true;
    }
    return this.entries.some((entry) => entry.upstreamUrl === track.audioUrl || entry.track.id === track.id);
  }

  isLocalUrlInUse(audioUrl: string): boolean {
    if (this.currentEntry?.track.audioUrl === audioUrl) {
      return true;
    }
    return this.entries.some((entry) => entry.track.audioUrl === audioUrl);
  }

  nextCandidate(tracks: Track[]): Track | undefined {
    if (this.cursor >= tracks.length) {
      return undefined;
    }
    const track = tracks[this.cursor];
    this.cursor += 1;
    return track;
  }

  addEntry(track: Track, upstreamUrl: string): boolean {
    if (this.entries.some((entry) => entry.track.id === track.id || entry.upstreamUrl === upstreamUrl)) {
      return false;
    }
    this.entries.push({ track, upstreamUrl });
    return true;
  }

  takeCurrent(correctTrack: Track): boolean {
    const index = this.entries.findIndex((entry) => entry.track.id === correctTrack.id);
    if (index < 0) {
      return false;
    }
    const [entry] = this.entries.splice(index, 1);
    this.currentEntry = entry;
    return true;
  }

  releaseCurrent(): AudioWindowEntry | undefined {
    const entry = this.currentEntry;
    this.currentEntry = undefined;
    return entry;
  }

  reset(): void {
    this.entries = [];
    this.cursor = 0;
    this.currentEntry = undefined;
    this.generation = nextGeneration();
  }
}

export type FillAudioWindowOptions = {
  state: AudioWindowState;
  tracks: Track[];
  targetSize: number;
  prepare: (track: Track) => Promise<Track | undefined>;
  onOrphan?: (track: Track) => void;
};

export async function fillAudioWindow({ state, tracks, targetSize, prepare, onOrphan }: FillAudioWindowOptions): Promise<void> {
  const generation = state.generationValue();
  while (state.size() < targetSize) {
    if (!state.isGenerationCurrent(generation)) {
      return;
    }

    const track = state.nextCandidate(tracks);
    if (!track) {
      return;
    }
    if (state.isPreparedOrActive(track)) {
      continue;
    }

    let prepared: Track | undefined;
    try {
      prepared = await prepare(track);
    } catch {
      continue;
    }
    if (!prepared) {
      continue;
    }

    if (!state.isGenerationCurrent(generation)) {
      onOrphan?.(prepared);
      return;
    }
    if (!state.addEntry(prepared, track.audioUrl)) {
      onOrphan?.(prepared);
    }
  }
}
