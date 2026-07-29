import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/**
 * Writes one physical FLAC part.
 *
 * The part is written to `<tempDir>/<uuid>.flac.part` and only moved into the
 * audio directory once ffmpeg has exited cleanly and the bytes are fsynced.
 * Anything under the audio directory is therefore always a complete, valid
 * FLAC: a power cut can lose the tail of a recording, never corrupt the
 * archive or hand Telegram a truncated file.
 */

export interface PartWriterOptions {
  readonly ffmpegPath: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly compressionLevel: number;
  readonly tempPath: string;
  readonly finalPath: string;
}

export interface FinalizedPart {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export class PartWriter {
  readonly #options: PartWriterOptions;
  #child: ChildProcessByStdio<Writable, null, Readable> | null = null;
  #stderr = '';
  #closed = false;

  constructor(options: PartWriterOptions) {
    this.#options = options;
  }

  buildArgs(): string[] {
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      String(this.#options.sampleRate),
      '-ac',
      String(this.#options.channels),
      '-i',
      'pipe:0',
      '-c:a',
      'flac',
      '-compression_level',
      String(this.#options.compressionLevel),
      // The muxer must be stated explicitly: the temp path ends in ".part", so
      // ffmpeg cannot infer the container from the extension.
      '-f',
      'flac',
      '-y',
      this.#options.tempPath,
    ];
  }

  open(): void {
    if (this.#child !== null) throw new Error('part writer already open');
    const child = spawn(this.#options.ffmpegPath, this.buildArgs(), {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4096);
    });
    // A dead encoder must not crash the recorder; close() surfaces the error.
    child.stdin.on('error', () => {});
    this.#child = child;
  }

  /** Backpressure-aware write. Resolves once the encoder has taken the bytes. */
  write(pcm: Uint8Array): Promise<void> {
    const child = this.#child;
    if (child === null) throw new Error('part writer is not open');
    return new Promise((resolve, reject) => {
      const ok = child.stdin.write(pcm, (error) => {
        if (error) reject(error);
      });
      if (ok) resolve();
      else child.stdin.once('drain', resolve);
    });
  }

  /**
   * Closes the encoder, fsyncs, atomically renames into place and returns the
   * checksum. Throws — leaving no file behind — if the encoder failed.
   */
  async close(): Promise<FinalizedPart> {
    const child = this.#child;
    if (child === null || this.#closed) throw new Error('part writer is not open');
    this.#closed = true;

    child.stdin.end();
    const code = await new Promise<number>((resolve) => {
      child.on('close', (exitCode) => resolve(exitCode ?? -1));
    });
    this.#child = null;

    if (code !== 0) {
      await rm(this.#options.tempPath, { force: true });
      throw new Error(`flac encoder exited with ${code}: ${this.#stderr.trim()}`);
    }

    await fsyncFile(this.#options.tempPath);
    await rename(this.#options.tempPath, this.#options.finalPath);
    // Fsync the directory too, or the rename itself can be lost on power loss.
    await fsyncDirectory(dirname(this.#options.finalPath));

    const info = await stat(this.#options.finalPath);
    const sha256 = await sha256File(this.#options.finalPath);
    return { path: this.#options.finalPath, bytes: info.size, sha256 };
  }

  /** Abandons the part without publishing it. */
  async abort(): Promise<void> {
    const child = this.#child;
    if (child !== null) {
      child.stdin.destroy();
      child.kill('SIGKILL');
      this.#child = null;
    }
    await rm(this.#options.tempPath, { force: true });
  }
}

export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch {
    // Directory fsync is not permitted on every filesystem; the rename is
    // still atomic, only its durability window is wider.
  } finally {
    await handle.close();
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

/** `audio/2026-07-29/<sessionId>.p000.flac` — sortable and date-partitioned. */
export function partPaths(
  audioDir: string,
  tempDir: string,
  sessionId: string,
  partIndex: number,
  startedWallMs: number,
): { finalPath: string; tempPath: string; dateDir: string; filename: string } {
  const date = new Date(startedWallMs).toISOString().slice(0, 10);
  const filename = `${sessionId}.p${String(partIndex).padStart(3, '0')}.flac`;
  const dateDir = join(audioDir, date);
  return {
    dateDir,
    filename,
    finalPath: join(dateDir, filename),
    tempPath: join(tempDir, `${filename}.part`),
  };
}
