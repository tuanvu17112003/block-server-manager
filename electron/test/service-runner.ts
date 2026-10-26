// Service test runner — executes management/store suites in the Electron main process.
import { TestRun } from './harness';
import { runManagementSuite, runStoreSuite } from './services/management.suite';
import { runPipelineSuite } from './services/pipeline.suite';

export interface SuiteResult {
  ok: boolean;
  report: string;
}

export async function runServiceTests(filter?: string): Promise<SuiteResult> {
  const run = new TestRun('services');
  const suites: { name: string; run: (target: TestRun) => Promise<void> }[] = [
    { name: 'store', run: runStoreSuite },
    { name: 'management', run: runManagementSuite },
    { name: 'pipeline', run: runPipelineSuite },
  ];
  for (const suite of suites) {
    if (filter && !suite.name.includes(filter)) continue;
    await suite.run(run);
  }
  const lines = run.lines();
  if (lines.length === 0) lines.push('FAIL services/no suites matched the filter');
  return { ok: run.ok, report: lines.join('\n') };
}
