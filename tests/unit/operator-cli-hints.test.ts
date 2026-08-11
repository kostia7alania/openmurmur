import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER_SURFACES = [
  'src/asr/worker-process.ts',
  'src/cli/doctor.ts',
  'src/cli/daemon.ts',
  'docs/TELEGRAM.md',
  'docs/DEPENDENCIES.md',
  'docs/SESSIONIZER.md',
  'docs/DATA_MODEL.md',
  'docs/ARCHITECTURE.md',
] as const;

const BARE_COMMAND =
  /(?<!pnpm )\bopenmurmur\s+(doctor|setup|capture|recover|start|stop|status|telegram|search|transcribe|digest|retention)\b/g;

describe('operator CLI hints', () => {
  it('uses commands that are runnable from the source checkout', () => {
    for (const file of OWNER_SURFACES) {
      const text = readFileSync(join(REPO, file), 'utf8');
      const bareCommands = [...text.matchAll(BARE_COMMAND)].map((match) => match[0]);
      assert.deepEqual(bareCommands, [], `${file} promises an uninstalled global binary`);
    }
  });
});
