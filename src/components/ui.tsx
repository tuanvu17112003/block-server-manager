import React from 'react';
import type { ServerStatus } from '../types';

// MC-look primitives (mc-style-001): chunky bevel buttons, stone panels,
// square status squares, XP-style bars. Pure CSS; Press Start 2P only on
// button labels / card titles / modal titles — body text stays system sans.
// Divergence note: full shadcn + Radix install deferred to keep the MVP
// dependency-free; class names mirror shadcn conventions for easy swap-in.

const BTN_TONE: Record<string, string> = {
  default: 'mc-btn-default',
  secondary: 'mc-btn-secondary',
  outline: 'mc-btn-outline',
  destructive: 'mc-btn-destructive',
  ghost: 'mc-btn-ghost',
};

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  title,
  className = '',
  pulse,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`mc-btn ${BTN_TONE[variant]} ${size === 'sm' ? 'mc-btn-sm' : ''} ${pulse ? 'pulse-start' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`mc-panel ${className}`}>{children}</div>;
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mc-cardtitle">{children}</h3>;
}

export const STATUS_COLOR: Record<ServerStatus, string> = {
  running: 'bg-[#48B518]',
  starting: 'bg-[#FFAA00]',
  stopping: 'bg-[#FFAA00]',
  stopped: 'bg-[#8B8B8B]',
  crashed: 'bg-[#FF5555]',
};

export function StatusDot({ status, size = 'h-2 w-2' }: { status: ServerStatus; size?: string }) {
  return <span title={status} className={`mc-dot ${STATUS_COLOR[status]} ${size}`} />;
}

export function Badge({ children, tone = 'zinc' }: { children: React.ReactNode; tone?: 'zinc' | 'green' | 'amber' | 'red' | 'blue' }) {
  const tones: Record<string, string> = {
    zinc: 'mc-badge-zinc',
    green: 'mc-badge-green',
    amber: 'mc-badge-amber',
    red: 'mc-badge-red',
    blue: 'mc-badge-blue',
  };
  return <span className={`mc-badge ${tones[tone]}`}>{children}</span>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'mc-input w-full px-2.5 py-1.5 text-sm placeholder-zinc-600';

export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="mc-empty">
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {body && <p className="mt-1 max-w-sm text-xs text-zinc-500">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, tone = 'bg-emerald-500' }: { value: number; tone?: string }) {
  const fillTone = tone.includes('blue') ? 'mc-bar-fill-blue' : tone.includes('amber') ? 'mc-bar-fill-amber' : '';
  return (
    <div className="mc-bar">
      <div className={`mc-bar-fill ${fillTone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** Focus trap + Escape + focus restoration for the dialog components (F-22). */
function useDialogA11y(open: boolean, onClose: () => void) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] => {
      const root = panelRef.current;
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
    };
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  return { panelRef, titleId };
}

export function Confirm({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { panelRef, titleId } = useDialogA11y(open, onClose);
  if (!open) return null;
  return (
    <div className="mc-modal-scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mc-modal w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="mc-modal-title">{title}</h3>
        <div className="mt-2 text-sm text-zinc-400">{message}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { panelRef, titleId } = useDialogA11y(open, onClose);
  if (!open) return null;
  return (
    <div className="mc-modal-scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mc-modal thin-scroll max-h-[85vh] w-full max-w-lg overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id={titleId} className="mc-modal-title">{title}</h3>
          <button onClick={onClose} aria-label="Close dialog" className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
