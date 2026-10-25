// Preload — the only bridge. Sandbox-compatible (ipcRenderer + contextBridge only).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('cmd:' + command, args ?? {}),
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
