import { readFileSync } from 'node:fs';

interface RuntimeRequirements {
  readonly schemaVersion: 1;
  readonly nodeMinimum: string;
  readonly sqliteMinimum: string;
  readonly pnpmExact: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const contractPath = new URL('../../runtime-requirements.json', import.meta.url);
const parsed: unknown = JSON.parse(readFileSync(contractPath, 'utf8'));

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  throw new Error('runtime-requirements.json must contain an object');
}

const values = parsed as Record<string, unknown>;
if (values['schemaVersion'] !== 1) {
  throw new Error('runtime-requirements.json has an unsupported schemaVersion');
}

for (const key of ['nodeMinimum', 'sqliteMinimum', 'pnpmExact'] as const) {
  const value = values[key];
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`runtime-requirements.json ${key} must be an exact x.y.z version`);
  }
}

export const RUNTIME_REQUIREMENTS: RuntimeRequirements = Object.freeze({
  schemaVersion: 1,
  nodeMinimum: values['nodeMinimum'] as string,
  sqliteMinimum: values['sqliteMinimum'] as string,
  pnpmExact: values['pnpmExact'] as string,
});

export const MINIMUM_NODE_VERSION = RUNTIME_REQUIREMENTS.nodeMinimum;
export const MINIMUM_SQLITE_VERSION = RUNTIME_REQUIREMENTS.sqliteMinimum;
