// Preload — the only bridge. Sandbox-compatible (ipcRenderer + contextBridge only).
// Command results arrive in the main-process envelope {__ipc:true, ok, value|error}; unwrap it
// here so Electron's "Error invoking remote method ..." prefix never reaches the renderer.
import { contextBridge, ipcRenderer } from 'electron';

interface Envelope {
  __ipc: true;
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string };
}

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    const result = await ipcRenderer.invoke('cmd:' + command, args ?? {}) as unknown;
    if (result !== null && typeof result === 'object' && (result as Partial<Envelope>).__ipc === true) {
      const envelope = result as Envelope;
      if (envelope.ok) return envelope.value;
      throw new Error(JSON.stringify(envelope.error ?? { code: 'internal', message: 'Backend error.' }));
    }
    return result;
  },
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    const allowed = channel.startsWith('server://') || channel.startsWith('job://') || channel.startsWith('curseforge://') || channel.startsWith('metrics://');
    if (!allowed) return () => {};
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pickMrpack: (): Promise<{ sourceId: string; fileName: string } | null> => ipcRenderer.invoke('dialog:pick-mrpack'),
  pickZip: (): Promise<{ name: string; size: number; modifiedAt: number | null } | null> => ipcRenderer.invoke('dialog:pick-zip'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
});
