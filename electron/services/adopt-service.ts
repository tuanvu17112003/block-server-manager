// Adoption: create store records for orphaned server folders.
//
// Kept in the app (not a one-off script) because the condition that produced the orphans — a failed install whose rollback
// removed the record but left the tree — can happen again, and the user then has no way to reach their data.
//
// Safety rules, all of them earned by inspecting real data:
//  - the folder is never moved, renamed or modified except server.properties when a port has to change
//  - a port clash gets a new free port rather than blocking adoption (two real folders shared 25534)
//  - duplicate installs collapse only on evidence (msm-install.json); no descriptor means never collapsed
//  - names are made unique because the store rejects duplicates and every orphan carried the default motd
//  - a folder without server.properties is skipped: it is a download, not an installation
import fs from 'node:fs';
import path from 'node:path';
import type { ServerDto, Store } from './store';
import {
  chooseFreePort,
  collapseDuplicates,
  findOrphanedServers,
  uniqueName,
  writePortIntoProperties,
  type AdoptableServer,
} from './adopt-orphans';

export interface AdoptPlanEntry {
  orphan: AdoptableServer;
  assignedName: string;
  originalPort: number;
  assignedPort: number;
  portChanged: boolean;
}

export interface AdoptResult {
  adopted: ServerDto[];
  plan: AdoptPlanEntry[];
  duplicates: AdoptableServer[];
  skipped: { id: string; reason: string }[];
}

/**
 * Build the adoption plan without writing anything.
 *
 * Separated from `adoptOrphans` so the UI (or a CLI) can show exactly what would happen before it happens. Adoption writes
 * to the user's data, so the reviewable step is not optional.
 */
export function planAdoption(dataRoot: string, store: Store): { plan: AdoptPlanEntry[]; duplicates: AdoptableServer[] } {
  const existing = store.listServers();
  const takenPorts = new Set(existing.map((server) => server.port));
  const takenNames = new Set(existing.map((server) => server.name));

  const orphans = findOrphanedServers(dataRoot, (id) => {
    try { return store.getServer(id) !== null; } catch { return false; }
  });
  const { keep, duplicates } = collapseDuplicates(orphans);

  const plan: AdoptPlanEntry[] = [];
  for (const orphan of keep) {
    const assignedPort = chooseFreePort(orphan.port, takenPorts);
    takenPorts.add(assignedPort);
    const assignedName = uniqueName(orphan.name, takenNames);
    takenNames.add(assignedName);
    plan.push({
      orphan,
      assignedName,
      originalPort: orphan.port,
      assignedPort,
      portChanged: assignedPort !== orphan.port,
    });
  }
  return { plan, duplicates };
}

/**
 * Adopt every orphaned folder, one at a time.
 *
 * Each entry is independent: a failure on one (a locked server.properties, an unexpected store conflict) is recorded and the
 * rest still proceed. Partial success is normal and better than refusing everything because one folder is problematic.
 *
 * server.properties is only rewritten when the assigned port differs from the one already configured; otherwise the
 * installation is left byte-for-byte alone.
 */
export function adoptOrphans(dataRoot: string, store: Store): AdoptResult {
  const { plan, duplicates } = planAdoption(dataRoot, store);
  const adopted: ServerDto[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const entry of plan) {
    const { orphan, assignedName, assignedPort, portChanged } = entry;
    try {
      if (portChanged) writePortIntoProperties(orphan.folder, assignedPort);

      const now = new Date().toISOString();
      const record: ServerDto = {
        id: orphan.id,
        name: assignedName,
        loader: orphan.loader,
        mcVersion: orphan.mcVersion,
        loaderVersion: orphan.loaderVersion,
        modpackId: null,
        port: assignedPort,
        // 2 GB is the app's default for a new server; an adopted tree has no recorded value, and a value that is too low
        // would fail to start while a too-high one merely reserves memory. This is the conservative middle.
        ramMb: 2048,
        javaPath: null,
        eulaAccepted: fs.existsSync(path.join(orphan.folder, 'eula.txt')),
        status: 'stopped',
        createdAt: now,
        worldName: orphan.worldName,
      };
      store.adoptServer(record);
      adopted.push(record);
    } catch (error) {
      skipped.push({ id: orphan.id, reason: (error as Error).message });
      // If the port was already rewritten and the record failed, put the original back so the folder is unchanged.
      if (portChanged && orphan.port > 0) {
        try { writePortIntoProperties(orphan.folder, orphan.port); } catch { /* best effort */ }
      }
    }
  }

  return { adopted, plan, duplicates, skipped };
}
