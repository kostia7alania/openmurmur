import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MINIMUM_NODE_VERSION as DOCTOR_NODE_MINIMUM } from '../../src/cli/doctor.ts';
import {
  MINIMUM_NODE_VERSION,
  MINIMUM_SQLITE_VERSION,
  RUNTIME_REQUIREMENTS,
} from '../../src/config/runtime-requirements.ts';
import { MINIMUM_SQLITE_VERSION as DATABASE_SQLITE_MINIMUM } from '../../src/database/db.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('runtime requirements contract', () => {
  it('keeps package metadata, .nvmrc and CI aligned with the authoritative contract', () => {
    const packageJson = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const engines = packageJson['engines'] as Record<string, unknown>;

    assert.equal(RUNTIME_REQUIREMENTS.schemaVersion, 1);
    assert.equal(readFileSync(join(REPO, '.nvmrc'), 'utf8').trim(), MINIMUM_NODE_VERSION);
    assert.equal(engines['node'], `>=${MINIMUM_NODE_VERSION}`);
    assert.equal(packageJson['packageManager'], `pnpm@${RUNTIME_REQUIREMENTS.pnpmExact}`);

    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    const ciNode = workflow.match(/^ {2}NODE_VERSION: ['"]([^'"]+)['"]$/m)?.[1];
    const ciPnpm = workflow.match(/^ {2}PNPM_VERSION: ['"]([^'"]+)['"]$/m)?.[1];
    const matrix = workflow.match(/^ {8}node: \[([^\]]+)\]$/m)?.[1] ?? '';
    const matrixVersions = [...matrix.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);

    assert.equal(ciNode, MINIMUM_NODE_VERSION);
    assert.equal(ciPnpm, RUNTIME_REQUIREMENTS.pnpmExact);
    assert.ok(matrixVersions.includes(MINIMUM_NODE_VERSION), 'CI matrix omits the Node floor');
  });

  it('keeps scripts and TypeScript gates on the contract instead of copied thresholds', () => {
    for (const relativePath of ['scripts/bootstrap', 'scripts/install-launch-agents']) {
      const source = readFileSync(join(REPO, relativePath), 'utf8');
      assert.match(
        source,
        /runtime-requirements\.json/,
        `${relativePath} does not load the contract`,
      );
      for (const version of [
        MINIMUM_NODE_VERSION,
        MINIMUM_SQLITE_VERSION,
        RUNTIME_REQUIREMENTS.pnpmExact,
      ]) {
        assert.equal(source.includes(version), false, `${relativePath} copies version ${version}`);
      }
    }

    assert.equal(DOCTOR_NODE_MINIMUM, MINIMUM_NODE_VERSION);
    assert.equal(DATABASE_SQLITE_MINIMUM, MINIMUM_SQLITE_VERSION);
  });
});
