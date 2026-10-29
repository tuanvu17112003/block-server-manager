// Systematic census of the REAL FTB API across every published pack, instead of the handful I happened to
// pick. This exists because seven bugs were found one at a time by trial and error; a census finds the whole
// class at once.
//
// It reports, as DATA:
//  - every field's observed value-space (so the adapter's assumptions are checked, not guessed),
//  - version ordering / id-vs-updated agreement (the bug that made FTB Omnia look vanilla),
//  - path/name shapes (the two bugs that dropped 155 mods and caused EEXIST),
//  - zero-size files, duplicate destinations, file-vs-directory collisions, unsafe paths,
//  - packs whose newest release declares no loader, and what fallbacks exist,
//  - per-MC-version counts and loader distribution.
//
// Usage: node scripts/census-ftb-api.mjs [--max-packs N] [--max-versions N]
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.modpacks.ch/public';
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const MAX_PACKS = argOf('--max-packs', 200);
const MAX_VERSIONS = argOf('--max-versions', 3);
const evidenceFile = path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'ftb-api-census.json');
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

const getJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
};

// ---- accumulators ----
const census = {
  harness: 'census-ftb-api.mjs',
  startedAt: new Date().toISOString(),
  packsScanned: 0,
  versionsScanned: 0,
  filesScanned: 0,
  fieldValueSpace: { targets: {}, types: {}, fileTypes: {}, statuses: {} },
  versionOrdering: { packsChecked: 0, ascendingById: 0, idMatchesUpdated: 0, descendingExceptions: [] },
  pathShapes: { pathEqualsName: 0, pathIsParentDir: 0, nameEmpty: 0, pathEmpty: 0, pathHasBackslash: 0, pathAbsolute: 0, samples: {} },
  hazards: {
    zeroSizeFiles: 0, duplicateDestinations: 0, fileDirCollisions: 0, unsafeRelativePaths: 0, identicalPathNameRepeats: 0,
    packsWithDuplicates: [], packsWithCollisions: [], packsWithUnsafePaths: [],
  },
  loader: { releasesWithoutLoader: [], packsWithNoLoaderInAnyVersion: [], loaderNames: {}, javaTargets: {} },
  mcVersions: {},
  packs: [],
};

/** Destination path exactly as the adapter computes it (mirrors resolveFtbDestPath). */
function destPath(file) {
  const normalize = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  const rawPath = normalize(file.path);
  const rawName = normalize(file.name);
  if (rawPath === '') return '';
  if (rawName === '') return rawPath;
  if (rawPath === rawName || rawPath.endsWith(`/${rawName}`)) return rawPath;
  if (!rawName.includes('/')) return `${rawPath.replace(/\/+$/, '')}/${rawName}`;
  return rawPath;
}

const bump = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1; };

try {
  const allPacks = await getJson(`${API}/modpack/all`);
  // The endpoint returns `{ packs: number[] }`, not a bare array.
  const idList = Array.isArray(allPacks) ? allPacks : (Array.isArray(allPacks?.packs) ? allPacks.packs : []);
  const packIds = idList.slice(0, MAX_PACKS);
  log(`census over ${packIds.length} packs (of ${idList.length} published), up to ${MAX_VERSIONS} versions each`);
  if (packIds.length === 0) throw new Error(`no pack ids returned by ${API}/modpack/all`);

  for (const packId of packIds) {
    let pack;
    try { pack = await getJson(`${API}/modpack/${packId}`); } catch { continue; }
    census.packsScanned += 1;
    const versions = Array.isArray(pack.versions) ? pack.versions : [];

    // ---- version ordering: is versions[] really ascending, and does id track updated? ----
    if (versions.length > 1) {
      census.versionOrdering.packsChecked += 1;
      const ids = versions.map(v => v.id);
      const ascendingById = ids.every((value, index) => index === 0 || value > ids[index - 1]);
      if (ascendingById) census.versionOrdering.ascendingById += 1;
      else census.versionOrdering.descendingExceptions.push({ packId, name: pack.name, ids });
      const withUpdated = versions.filter(v => typeof v.updated === 'number');
      if (withUpdated.length > 1) {
        const byId = [...withUpdated].sort((a, b) => a.id - b.id).map(v => v.id).join(',');
        const byUpdated = [...withUpdated].sort((a, b) => a.updated - b.updated).map(v => v.id).join(',');
        if (byId === byUpdated) census.versionOrdering.idMatchesUpdated += 1;
      }
    }

    // ---- newest release (what the adapter picks) ----
    const recency = (v) => (typeof v.updated === 'number' ? v.updated : v.id);
    const sorted = [...versions].sort((a, b) => recency(b) - recency(a));
    const picked = sorted.find(v => String(v.type ?? '').toLowerCase() === 'release') ?? sorted[0];
    const pickedTargets = Array.isArray(picked?.targets) ? picked.targets : [];
    const pickedLoader = pickedTargets.find(t => t.type === 'modloader');
    for (const target of pickedTargets) {
      bump(census.fieldValueSpace.targets, `${target.name}:${target.type}`);
      if (target.type === 'runtime') bump(census.loader.javaTargets, String(target.version).split('.')[0]);
    }
    if (!pickedLoader) {
      census.loader.releasesWithoutLoader.push({ packId, name: pack.name, versionId: picked?.id, versionName: picked?.name, type: picked?.type });
    }
    const anyLoader = versions.some(v => (v.targets ?? []).some(t => t.type === 'modloader'));
    if (!anyLoader) census.loader.packsWithNoLoaderInAnyVersion.push({ packId, name: pack.name });
    if (pickedLoader) bump(census.loader.loaderNames, pickedLoader.name);

    // ---- file shapes across a few versions ----
    const versionSlice = sorted.slice(0, MAX_VERSIONS);
    for (const versionRef of versionSlice) {
      let detail;
      try { detail = await getJson(`${API}/modpack/${packId}/${versionRef.id}`); } catch { continue; }
      census.versionsScanned += 1;
      const files = Array.isArray(detail.files) ? detail.files : [];
      census.filesScanned += files.length;
      const mcTarget = (detail.targets ?? []).find(t => t.type === 'game');
      const mc = String(mcTarget?.version ?? '?');
      census.mcVersions[mc] = (census.mcVersions[mc] ?? 0) + 1;

      const destinations = new Map();
      for (const file of files) {
        bump(census.fieldValueSpace.fileTypes, String(file.type ?? '(none)'));
        const rawPath = String(file.path ?? '');
        const rawName = String(file.name ?? '');
        if (rawName === '') census.pathShapes.nameEmpty += 1;
        if (rawPath === '') census.pathShapes.pathEmpty += 1;
        if (rawPath.includes('\\')) census.pathShapes.pathHasBackslash += 1;
        if (/^[/\\]|^[A-Za-z]:/.test(rawPath)) census.pathShapes.pathAbsolute += 1;

        const normalizedPath = rawPath.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
        const normalizedName = rawName.replaceAll('\\', '/');
        if (normalizedPath === normalizedName) census.pathShapes.pathEqualsName += 1;
        else if (normalizedName !== '' && !normalizedPath.endsWith(`/${normalizedName}`)) census.pathShapes.pathIsParentDir += 1;

        if (Number(file.size) === 0) census.hazards.zeroSizeFiles += 1;

        const dest = destPath(file);
        if (dest === '') continue;
        if (dest.split('/').some(segment => segment === '..')) {
          census.hazards.unsafeRelativePaths += 1;
          census.hazards.packsWithUnsafePaths.push({ packId, dest });
        }
        destinations.set(dest, (destinations.get(dest) ?? 0) + 1);
      }

      // duplicate destinations within one version
      const dupes = [...destinations.entries()].filter(([, count]) => count > 1);
      if (dupes.length > 0) {
        census.hazards.duplicateDestinations += dupes.length;
        census.hazards.packsWithDuplicates.push({ packId, versionId: versionRef.id, count: dupes.length, samples: dupes.slice(0, 5).map(([dest, n]) => `${dest} x${n}`) });
      }

      // file-vs-directory collisions: one destination is a prefix directory of another
      const keys = [...destinations.keys()];
      const keySet = new Set(keys);
      const collisions = [];
      for (const key of keys) {
        const parts = key.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          const prefix = parts.slice(0, index).join('/');
          if (keySet.has(prefix)) { collisions.push(`${prefix} (dir) vs ${key} (file)`); break; }
        }
      }
      if (collisions.length > 0) {
        census.hazards.fileDirCollisions += collisions.length;
        census.hazards.packsWithCollisions.push({ packId, versionId: versionRef.id, samples: collisions.slice(0, 5) });
      }
    }
    census.packs.push({ packId, name: pack.name, versions: versions.length, pickedVersion: picked?.id, pickedType: picked?.type, pickedLoader: pickedLoader ? `${pickedLoader.name}=${pickedLoader.version}` : null });
  }

  // ---- summary verdicts as data ----
  census.summary = {
    versionOrderingAlwaysAscending: census.versionOrdering.packsChecked > 0
      && census.versionOrdering.ascendingById === census.versionOrdering.packsChecked,
    idAlwaysTracksUpdated: census.versionOrdering.idMatchesUpdated === census.versionOrdering.packsChecked,
    packsWhoseNewestReleaseLacksLoader: census.loader.releasesWithoutLoader.length,
    packsWithNoLoaderAnywhere: census.loader.packsWithNoLoaderInAnyVersion.length,
    pathConventionSplit: {
      fullPath: census.pathShapes.pathEqualsName,
      parentDirPlusName: census.pathShapes.pathIsParentDir,
    },
  };
  log(`packs=${census.packsScanned} versions=${census.versionsScanned} files=${census.filesScanned}`);
  log(`version ordering ascending in ${census.versionOrdering.ascendingById}/${census.versionOrdering.packsChecked} packs; id tracks updated in ${census.versionOrdering.idMatchesUpdated}/${census.versionOrdering.packsChecked}`);
  log(`path shapes: fullPath=${census.pathShapes.pathEqualsName} parentDir+name=${census.pathShapes.pathIsParentDir}`);
  log(`hazards: zeroSize=${census.hazards.zeroSizeFiles} dupDests=${census.hazards.duplicateDestinations} fileDirCollisions=${census.hazards.fileDirCollisions} unsafe=${census.hazards.unsafeRelativePaths}`);
  log(`newest release lacks loader: ${census.loader.releasesWithoutLoader.length} packs; no loader anywhere: ${census.loader.packsWithNoLoaderInAnyVersion.length}`);
  console.log(`\nloader distribution: ${JSON.stringify(census.loader.loaderNames)}`);
  console.log(`mc versions: ${JSON.stringify(census.mcVersions)}`);
  console.log(`java majors: ${JSON.stringify(census.loader.javaTargets)}`);
  if (census.loader.releasesWithoutLoader.length > 0) {
    console.log('\nnewest release without a loader target:');
    for (const entry of census.loader.releasesWithoutLoader.slice(0, 10)) console.log(`  ${entry.packId} ${entry.name} v${entry.versionId} ${entry.versionName} (${entry.type})`);
  }
  census.verdict = 'COMPLETE';
} catch (error) {
  census.verdict = 'ERROR';
  census.error = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${census.error}`);
  process.exitCode = 1;
} finally {
  census.finishedAt = new Date().toISOString();
  census.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(census, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}
