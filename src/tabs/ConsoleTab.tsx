import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Badge, Button, Confirm } from '../components/ui';
import { hasBackend, tauriServers } from '../tauri';
import { CONSOLE_LOG_OVERSCAN, CONSOLE_LOG_ROW_HEIGHT, MAX_RETAINED_LOG_LINES } from '../logs';

const QUICK = ['save-all', 'say Server restart in 5 min!', 'time set day', 'weather clear'];

export default function ConsoleTab() {
  const { active, logs, sendCommand, clearLogs, cmdHistory, pushToast, stop, restart, kill } = useStore();
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('All');
  const [auto, setAuto] = useState(true);
  const [killOpen, setKillOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  const serverLogs = logs[active.id] ?? [];
  const lines = useMemo(
    () => serverLogs.filter(
      (l) => (level === 'All' || l.level === level) && (!q || (l.msg + l.source).toLowerCase().includes(q.toLowerCase())),
    ),
    [level, q, serverLogs],
  );
  const measureViewport = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const next = { scrollTop: box.scrollTop, height: box.clientHeight };
    setViewport((current) =>
      current.scrollTop === next.scrollTop && current.height === next.height ? current : next,
    );
  }, []);
  const running = active.status === 'running';
  // Attached = the launcher owns a live stdin handle, which is exactly while the tracked process runs.
  const attached = running;

  useEffect(() => {
    measureViewport();
    const box = boxRef.current;
    if (!box) return;
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measureViewport);
      observer.observe(box);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measureViewport);
    return () => window.removeEventListener('resize', measureViewport);
  }, [measureViewport]);

  useEffect(() => {
    const box = boxRef.current;
    if (auto && box) {
      box.scrollTop = box.scrollHeight;
      measureViewport();
    }
  }, [active.id, auto, lines, measureViewport]);

  const visibleStart = Math.max(
    0,
    Math.floor(viewport.scrollTop / CONSOLE_LOG_ROW_HEIGHT) - CONSOLE_LOG_OVERSCAN,
  );
  const visibleEnd = Math.min(
    lines.length,
    Math.ceil((viewport.scrollTop + viewport.height) / CONSOLE_LOG_ROW_HEIGHT) + CONSOLE_LOG_OVERSCAN,
  );
  const visibleLines = lines.slice(visibleStart, visibleEnd);

  const send = () => {
    if (!running) {
      pushToast('Server is not running — command not sent.', 'err');
      return;
    }
    sendCommand(active.id, input);
    setInput('');
    setHistIdx(-1);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') send();
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = histIdx < 0 ? cmdHistory.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      if (cmdHistory[i]) setInput(cmdHistory[i]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const i = histIdx < 0 ? -1 : Math.min(cmdHistory.length - 1, histIdx + 1);
      setHistIdx(i);
      setInput(i < 0 ? '' : cmdHistory[i] ?? '');
    }
  };

  const exportLog = async () => {
    let text = serverLogs.map((l) => `${l.ts} [${l.level}] [${l.source}] ${l.msg}`).join('\n');
    if (hasBackend()) {
      // Prefer the backend-served, rotation-tolerant history so the export can include lines that
      // have already rolled out of the renderer's retained buffer.
      try {
        const raw = await tauriServers.logsTail(active.id, 10_000);
        if (raw.length > 0) text = raw.join('\n');
      } catch {
        // Fall back to the retained renderer buffer; never block the export on log history.
      }
    }
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${active.name.replace(/\s+/g, '-').toLowerCase()}-console.log`;
    a.click();
    URL.revokeObjectURL(a.href);
    pushToast(hasBackend() ? 'Console exported as .log' : 'Console exported as .log (mock)', 'ok');
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={attached ? 'green' : 'zinc'}>{attached ? '● attached' : '○ detached'}</Badge>
        <span className="text-[11px] text-zinc-500" title={attached ? 'Commands are written to the tracked process stdin' : 'Commands are unavailable while the server is not running'}>
          {attached ? 'stdin attached' : 'stdin detached'}
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search / filter…" className="w-48 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs outline-none focus:border-emerald-500" />
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs">
          {['All', 'INFO', 'WARN', 'ERROR', 'CMD'].map((l) => <option key={l}>{l}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-scroll
        </label>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => clearLogs(active.id)}>Clear</Button>
          <Button size="sm" variant="outline" onClick={exportLog}>Export</Button>
          <Button size="sm" variant="secondary" onClick={() => stop(active.id)} disabled={!running}>Stop</Button>
          <Button size="sm" variant="secondary" onClick={() => restart(active.id)} disabled={!running && active.status !== 'crashed'}>Restart</Button>
          <Button size="sm" variant="outline" onClick={() => setKillOpen(true)}>Kill…</Button>
        </div>
      </div>

      {serverLogs.length >= MAX_RETAINED_LOG_LINES && (
        <p className="font-sans text-xs text-amber-400">
          Console history is capped at {MAX_RETAINED_LOG_LINES.toLocaleString()} lines. Older output rolls off as new lines arrive; export includes retained history only.
        </p>
      )}

      <div ref={boxRef} onScroll={measureViewport} className="mc-console log-scroll min-h-[300px] flex-1 overflow-auto">
        {lines.length === 0 ? (
          <p className="p-3 font-sans text-zinc-600">No lines match the current search and level filters.</p>
        ) : (
          <div style={{ height: lines.length * CONSOLE_LOG_ROW_HEIGHT, minWidth: '100%', position: 'relative' }}>
            {visibleLines.map((l, index) => (
              <div
                key={l.id}
                className={l.level === 'ERROR' ? 'bg-red-950/40' : ''}
                style={{
                  position: 'absolute',
                  top: (visibleStart + index) * CONSOLE_LOG_ROW_HEIGHT,
                  left: 0,
                  height: CONSOLE_LOG_ROW_HEIGHT,
                  lineHeight: `${CONSOLE_LOG_ROW_HEIGHT}px`,
                  minWidth: '100%',
                  width: 'max-content',
                  padding: '0 12px',
                  whiteSpace: 'nowrap',
                }}
              >
                <span className="text-zinc-600">{l.ts}</span>{' '}
                <span className={l.level === 'ERROR' ? 'font-bold text-red-400' : l.level === 'WARN' ? 'text-amber-400' : l.level === 'CMD' ? 'text-emerald-400' : 'text-zinc-500'}>
                  [{l.level}]
                </span>{' '}
                <span className="text-zinc-500">[{l.source}]</span> <span className="text-zinc-200">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((c) => (
          <button key={c} onClick={() => { setInput(c); }} title="Fill into command input"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-xs text-zinc-300 hover:border-emerald-600">
            {c}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <span className="py-1.5 font-mono text-sm text-emerald-500">&gt;</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={running ? 'Type a command… (Enter sends, ↑ history)' : 'Server stopped — start it to send commands'}
          disabled={!running}
          title={running ? 'Command input' : 'Disabled: server is stopped'}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-500 disabled:opacity-50"
        />
        <Button onClick={send} disabled={!running}>Send</Button>
      </div>

      <Confirm
        open={killOpen}
        title="Force-kill server process?"
        message={<p>Unsaved progress may be lost. This is the emergency brake for a frozen server.</p>}
        confirmLabel="Kill process"
        onConfirm={() => kill(active.id)}
        onClose={() => setKillOpen(false)}
      />
    </div>
  );
}
