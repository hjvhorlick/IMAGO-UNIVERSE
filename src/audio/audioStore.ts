/**
 * Imported sound.
 *
 * The application ships NO audio. There is no music library, no bundled tracks
 * and nothing to browse - this module only stores files the user brings in, and
 * the rights to those files are the user's responsibility.
 *
 * Blobs live in the same IndexedDB object store as imported artwork, under an
 * `audio:` key prefix, so no schema migration is needed.
 */
import type { SceneAudio } from '../core/types';
import { idbDel, idbGet, idbSet } from '../project/idb';
import { uid } from '../core/util';

const STORE = 'importedAssets';
const key = (id: string) => `audio:${id}`;

const ACCEPT = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
  'audio/mp4', 'audio/aac', 'audio/webm', 'audio/flac'];

export const AUDIO_ACCEPT = '.mp3,.wav,.ogg,.m4a,.aac,.webm,.flac,audio/*';

export function looksLikeAudio(file: File): boolean {
  if (ACCEPT.includes(file.type)) return true;
  return /\.(mp3|wav|ogg|m4a|aac|webm|flac)$/i.test(file.name);
}

/**
 * Read the duration without playing anything. Best-effort: some browsers refuse
 * metadata for a blob URL, and jsdom has no media stack at all, so this resolves
 * to 0 rather than hanging. A duration of 0 simply means "unknown".
 */
function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: number) => { if (!done) { done = true; resolve(v); } };
    try {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      const timer = setTimeout(() => finish(0), 2500);
      a.onloadedmetadata = () => {
        clearTimeout(timer);
        finish(Number.isFinite(a.duration) ? a.duration : 0);
      };
      a.onerror = () => { clearTimeout(timer); finish(0); };
      a.src = url;
    } catch { finish(0); }
  });
}

export async function importAudio(file: File): Promise<SceneAudio> {
  if (!looksLikeAudio(file)) {
    throw new Error(`"${file.name}" does not look like an audio file. Use mp3, wav, ogg, m4a, aac or flac.`);
  }
  // 60 MB is generous for a music track and keeps the .sceneproject sane.
  if (file.size > 60 * 1024 * 1024) {
    throw new Error(`"${file.name}" is ${(file.size / 1e6).toFixed(0)} MB. Keep sound under 60 MB so projects stay portable.`);
  }
  const id = uid('audio');
  const url = URL.createObjectURL(file);
  const duration = await probeDuration(url);
  URL.revokeObjectURL(url);

  const audio: SceneAudio = {
    id,
    name: file.name.replace(/\.[^.]+$/, ''),
    duration,
    volume: 0.8,
    loop: true,
    // Music has an intro and an outro, so a plain repeat has an audible join.
    // Default to a short crossfade rather than pretending the loop is seamless.
    crossfade: 1.5,
    offset: 0,
    mime: file.type || 'audio/mpeg',
    bytes: file.size,
  };
  await idbSet(STORE, key(id), { audio, blob: file });
  return audio;
}

export async function loadAudioBlob(id: string): Promise<Blob | null> {
  const rec = await idbGet<{ audio: SceneAudio; blob: Blob }>(STORE, key(id));
  return rec?.blob ?? null;
}

/**
 * The bytes a project needs for this scene's sound, or null if the scene is
 * silent or the file is no longer in this browser. Never throws: a save should
 * not fail because a sound is unreadable.
 */
export async function loadSceneSound(audio: SceneAudio | null | undefined): Promise<Blob | null> {
  if (!audio) return null;
  try { return await loadAudioBlob(audio.id); } catch { return null; }
}

export async function removeAudio(id: string): Promise<void> {
  await idbDel(STORE, key(id));
}

/** Used by the project reader to re-register bytes from a .sceneproject. */
export async function registerAudioBlob(audio: SceneAudio, blob: Blob): Promise<void> {
  await idbSet(STORE, key(audio.id), { audio, blob });
}
