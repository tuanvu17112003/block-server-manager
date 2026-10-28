// In-app CurseForge modpack browsing (official API search): pure mapping + the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapCurseForgeSearchPayload, searchCurseForgeModpacks } from '../../services/installer/curseforge';

test('maps a real official /mods/search payload to renderer-safe hits', () => {
  const payload = {
    data: [
      {
        id: 392141,
        name: 'SkyFactory 5',
        slug: 'skyfactory-5',
        summary: 'A skyblock modpack with automation.',
        downloadCount: 1234567,
        dateModified: '2026-10-20T10:00:00Z',
        logo: { thumbnailUrl: 'https://media.forgecdn.net/avatars/thumbnails/1.png' },
        links: { websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/skyfactory-5' },
        authors: [{ name: 'FTB' }],
      },
    ],
    pagination: { totalCount: 42 },
  };
  const result = mapCurseForgeSearchPayload(payload, 20, 20);
  assert.equal(result.totalHits, 42);
  assert.equal(result.offset, 20);
  assert.equal(result.limit, 20);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0], {
    projectId: 392141,
    name: 'SkyFactory 5',
    slug: 'skyfactory-5',
    summary: 'A skyblock modpack with automation.',
    author: 'FTB',
    downloads: 1234567,
    updatedAt: '2026-10-20T10:00:00Z',
    iconUrl: 'https://media.forgecdn.net/avatars/thumbnails/1.png',
    websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/skyfactory-5',
  });
});

test('tolerates missing optional fields and drops invalid rows', () => {
  const payload = {
    data: [
      null,
      { id: 0, name: 'bad id' },
      { id: 5, name: '' },
      { id: 6, name: 'Valid Pack' },
    ],
  };
  const result = mapCurseForgeSearchPayload(payload, 0, 20);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.projectId, 6);
  assert.equal(result.hits[0]!.author, null);
  assert.equal(result.hits[0]!.downloads, 0);
  assert.equal(result.hits[0]!.iconUrl, null);
  assert.equal(result.hits[0]!.websiteUrl, null);
  // Without pagination the mapper falls back to the row count instead of NaN.
  assert.equal(result.totalHits, 1);
});

test('handles a non-object payload without throwing', () => {
  const result = mapCurseForgeSearchPayload(null, 0, 20);
  assert.deepEqual(result, { hits: [], totalHits: 0, offset: 0, limit: 20 });
});

test('searching without a configured API key fails with an actionable validation error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-cf-search-'));
  try {
    await assert.rejects(
      () => searchCurseForgeModpacks('skyfactory', root),
      (error: unknown) => (error as { code?: string }).code === 'validation'
        && /Settings/i.test((error as Error).message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
