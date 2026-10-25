// Data-root resolution: dev keeps everything inside the project; packaged uses userData.
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let cached: string | null = null;

export function dataRoot(): string {
  if (cached) return cached;
  cached = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(app.getAppPath(), '.app-data');
  fs.mkdirSync(cached, { recursive: true });
  return cached;
}
