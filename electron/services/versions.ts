// Version/loader listings — piston-meta vanilla, fill.papermc.io v3 paper, loader metas.
// DTO shapes match src/tauri.ts (MinecraftVersionDto, LoaderChoiceDto).
import { fetchOk } from './installer/core';

export interface MinecraftVersionDto { id: string; releaseTime: string; versionType: string }

export async function vanillaVersions(): Promise<MinecraftVersionDto[]> {
  const manifest = await (await fetchOk('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json() as {
    latest: Record<string, string>;
    versions: { id: string; releaseTime: string; type: string }[];
  };
  return manifest.versions.map(v => ({ id: v.id, releaseTime: v.releaseTime, versionType: v.type }));
}

export async function paperVersions(): Promise<MinecraftVersionDto[]> {
  // fill v3 (verified live): /projects/paper/versions -> { versions: [{ version: { id, support } }] }
  const j = await (await fetchOk('https://fill.papermc.io/v3/projects/paper/versions')).json() as {
    versions?: { version: { id: string; support?: { status?: string } } }[];
  };
  return (j.versions ?? [])
    .filter(v => typeof v.version?.id === 'string')
    .map(v => ({ id: v.version.id, releaseTime: '', versionType: v.version.support?.status === 'SUPPORTED' ? 'release' : 'snapshot' }));
}

export interface LoaderChoiceDto { loader: 'Vanilla' | 'Paper' | 'Fabric' | 'Forge' | 'NeoForge'; version: string | null; label: string; stable?: boolean | null }

export async function loadersResolve(mcVersion: string): Promise<LoaderChoiceDto[]> {
  const out: LoaderChoiceDto[] = [{ loader: 'Vanilla', version: null, label: `Vanilla ${mcVersion}`, stable: true }];
  out.push({ loader: 'Paper', version: mcVersion, label: `Paper ${mcVersion} (latest build)`, stable: true });
  try {
    const fabric = await (await fetchOk(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`)).json() as { loader: { version: string; stable: boolean } }[];
    if (fabric.length) out.push({ loader: 'Fabric', version: fabric[0].loader.version, label: `Fabric Loader ${fabric[0].loader.version}`, stable: fabric[0].loader.stable });
  } catch { /* no fabric for this MC */ }
  try {
    const promos = await (await fetchOk('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).json() as { promos: Record<string, string> };
    const forge = promos.promos[`${mcVersion}-recommended`] ?? promos.promos[`${mcVersion}-latest`];
    if (forge) out.push({ loader: 'Forge', version: forge, label: `Forge ${forge}`, stable: true });
  } catch { /* no forge promo */ }
  try {
    // MC 26.x builds live under the `neoforge` artifact; MC 1.x builds under legacy `net.neoforged:forge` (R-01).
    const metas = await Promise.all([
      fetchOk('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml').then(r => r.text()).catch(() => ''),
      fetchOk('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml').then(r => r.text()).catch(() => ''),
    ]);
    const all = metas.flatMap(xml => [...xml.matchAll(/<version>([\d.]+(?:-[\w.]+)?)<\/version>/g)].map(m => m[1]));
    const prefix = mcVersion.split('.').slice(0, 2).join('.') + '.';
    const match = all.filter(v => v.startsWith(prefix)).pop();
    if (match) out.push({ loader: 'NeoForge', version: match, label: `NeoForge ${match}`, stable: true });
  } catch { /* no neoforge */ }
  return out;
}
