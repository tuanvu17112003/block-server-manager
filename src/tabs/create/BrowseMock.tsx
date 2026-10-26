// Create step 2 (browser/mock mode) — static modpack catalogue (extracted from Create.tsx, WP-6.5).
import { Badge, Button, Card, inputCls } from '../../components/ui';
import type { Modpack } from '../../types';
import { MC_VERSIONS, LOADERS } from '../../mocks/data';
import { fmtDl, type Kind } from './helpers';

interface BrowseMockProps {
  q: string;
  onQueryChange: (value: string) => void;
  sourceTab: 'all' | 'curseforge' | 'modrinth';
  onSourceTabChange: (value: 'all' | 'curseforge' | 'modrinth') => void;
  mc: string;
  onMcChange: (value: string) => void;
  loader: string;
  onLoaderChange: (value: string) => void;
  sort: 'popular' | 'name';
  onSortChange: (value: 'popular' | 'name') => void;
  results: Modpack[];
  onPickPack: (pack: Modpack) => void;
  onBack: () => void;
  kind: Kind;
}

export function BrowseMock(props: BrowseMockProps) {
  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Search modpacks" value={props.q} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search modpacks…" className={`${inputCls} max-w-xs`} />
          <div className="flex gap-1">
            {(['all', 'curseforge', 'modrinth'] as const).map((source) => (
              <button key={source} onClick={() => props.onSourceTabChange(source)} className={`rounded px-2 py-1 text-xs ${props.sourceTab === source ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300'}`}>{source}</button>
            ))}
          </div>
          <select aria-label="Filter modpacks by Minecraft version" value={props.mc} onChange={(event) => props.onMcChange(event.target.value)} className={`${inputCls} w-auto`}>
            <option>Any</option>{MC_VERSIONS.map((version) => <option key={version}>{version}</option>)}
          </select>
          <select aria-label="Filter modpacks by loader" value={props.loader} onChange={(event) => props.onLoaderChange(event.target.value)} className={`${inputCls} w-auto`}>
            {LOADERS.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select aria-label="Sort modpacks" value={props.sort} onChange={(event) => props.onSortChange(event.target.value as 'popular' | 'name')} className={`${inputCls} w-auto`}>
            <option value="popular">Sort: Popular</option>
            <option value="name">Sort: Name A-Z</option>
          </select>
        </div>
        <p className="mt-2 text-xs text-zinc-500">{props.results.length} pack(s) · Modrinth is the default open source catalog.</p>
      </Card>
      <div className="mc-create-pack-grid grid gap-3">
        {props.results.map((modpack) => (
          <Card key={modpack.id}>
            <div className="flex gap-3">
              <div className="text-3xl">{modpack.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{modpack.name}</span>
                  <Badge tone={modpack.source === 'modrinth' ? 'green' : 'amber'}>{modpack.source === 'modrinth' ? 'MR' : 'CF'}</Badge>
                </div>
                <div className="text-xs text-zinc-500">by {modpack.author} · {fmtDl(modpack.downloads)} downloads · MC {modpack.mcVersions.join(', ')}</div>
                <p className="mt-1 text-xs text-zinc-400">{modpack.summary}</p>
                <div className="mt-2"><Button size="sm" onClick={() => props.onPickPack(modpack)}>Select →</Button></div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {props.results.length === 0 && <p className="text-sm text-zinc-500">No packs match these filters.</p>}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={props.onBack}>← Back</Button>
      </div>
    </div>
  );
}

export type { BrowseMockProps };
