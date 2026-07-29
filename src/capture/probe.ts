import { spawn } from 'node:child_process';
import type { ProbeResult } from '../telegram/incoming.ts';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string };
}

/**
 * Reads real container metadata. Returns null when the file is unreadable,
 * which the caller treats as corrupt media.
 *
 * `-analyzeduration`/`-probesize` are bounded so a crafted file cannot make
 * ffprobe read gigabytes looking for a stream.
 */
export async function probeAudio(
  ffprobePath: string,
  filePath: string,
  timeoutMs = 20_000,
): Promise<ProbeResult | null> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-analyzeduration',
    '10000000',
    '-probesize',
    '10000000',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-i',
    filePath,
  ];

  const output = await runCapture(ffprobePath, args, timeoutMs);
  if (output === null) return null;

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(output) as FfprobeOutput;
  } catch {
    return null;
  }

  const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  if (audio === undefined || audio.codec_name === undefined) return null;

  const duration = Number.parseFloat(audio.duration ?? parsed.format?.duration ?? 'NaN');
  return {
    codec: audio.codec_name,
    formatName: parsed.format?.format_name ?? 'unknown',
    durationSeconds: duration,
    channels: audio.channels ?? 0,
    sampleRate: Number.parseInt(audio.sample_rate ?? '0', 10),
  };
}

/**
 * Decodes any supported input to 16 kHz mono 16-bit WAV, the only shape the
 * ASR worker accepts. Returns false when the transcode fails.
 */
export async function normalizeToWav(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    // Refuse anything that is not a plain audio container.
    '-i',
    inputPath,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    '-y',
    outputPath,
  ];
  return (await runCapture(ffmpegPath, args, timeoutMs)) !== null;
}

function runCapture(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Bound the buffer: ffprobe JSON for a real file is a few KB.
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? stdout : null));
  });
}
