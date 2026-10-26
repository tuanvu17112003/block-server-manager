// CreateChrome — hidden file inputs + step indicator for the wizard (extracted from Create.tsx, WP-6.5).
import type { MutableRefObject } from 'react';

interface CreateChromeProps {
  step: number;
  localMrpackInputRef: MutableRefObject<HTMLInputElement | null>;
  curseforgeZipInputRef: MutableRefObject<HTMLInputElement | null>;
  onLocalMrpackFile: (file: File) => void;
  onCurseforgeZipFile: (file: File) => void;
}

export function CreateChrome(props: CreateChromeProps) {
  return (
    <>
      <input
        ref={props.localMrpackInputRef}
        type="file"
        accept=".mrpack,application/zip"
        aria-label="Local .mrpack file"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) props.onLocalMrpackFile(file);
        }}
      />
      <input
        ref={props.curseforgeZipInputRef}
        type="file"
        accept=".zip,application/zip"
        aria-label="CurseForge server ZIP"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) props.onCurseforgeZipFile(file);
        }}
      />
      <ol className="flex flex-wrap gap-2 text-xs">
        {['1 Type', '2 Browse', '3 Configure', '4 Install'].map((label, index) => (
          <li key={label} className={`rounded px-2 py-1 ${props.step === index + 1 ? 'bg-emerald-900 text-emerald-200' : 'bg-zinc-900 text-zinc-500'}`}>{label}</li>
        ))}
      </ol>
    </>
  );
}

export type { CreateChromeProps };
