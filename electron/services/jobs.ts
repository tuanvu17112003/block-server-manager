// Job registry — id → AbortController + progress broadcast on `job://progress/{jobId}`.
// Matches the Rust payload {progress, stage, log, bytesDownloaded, bytesTotal}.
export interface JobProgress { progress: number; stage?: string; log?: string; bytesDownloaded?: number; bytesTotal?: number }

export class Jobs {
  private controllers = new Map<string, AbortController>();
  private cancelled = new Set<string>();

  constructor(private send: (channel: string, payload: unknown) => void) {}

  begin(jobId: string): AbortController {
    const c = new AbortController();
    this.controllers.set(jobId, c);
    return c;
  }

  isCancelled(jobId: string): boolean { return this.cancelled.has(jobId); }

  /**
   * AbortSignal owned by a running job (undefined while inactive). Installer engines accept it
   * directly via their `{ signal }` option; `cancel(jobId)` aborts it.
   */
  signalFor(jobId: string): AbortSignal | undefined { return this.controllers.get(jobId)?.signal; }

  cancel(jobId: string): boolean {
    const c = this.controllers.get(jobId);
    if (!c) return false;
    c.abort();
    this.cancelled.add(jobId);
    return true;
  }

  progress(jobId: string, p: JobProgress): void {
    this.send(`job://progress/${jobId}`, p);
  }

  end(jobId: string): void {
    this.controllers.delete(jobId);
    this.cancelled.delete(jobId);
  }
}
