import { createHash } from 'node:crypto';
import { switchCodeBundle } from './code-bundle.mjs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isFile, workerExecutablePaths, sealWorkerBundle } from './agent-services.mjs';
import {
  downloadWorkerBuild,
  installWorkerBuild,
  workerBuildInfo,
  workerBuildManifest,
} from './worker-update.mjs';

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Repair is a transaction through bundle sealing and service restart, not just the file swap. */
export async function ensureWorkerBuild(
  serverUrl,
  agentDir,
  {
    paths = workerExecutablePaths(agentDir),
    platform = process.platform,
    arch = process.arch,
    download = downloadWorkerBuild,
    install = installWorkerBuild,
    seal = sealWorkerBundle,
    restartServices = () => {},
    readBuildInfo = workerBuildInfo,
    manifestFor = workerBuildManifest,
    print = console.log,
  } = {},
) {
  const hadWorker = isFile(paths.executable);
  let before;
  try {
    if (hadWorker) before = await readBuildInfo(paths.executable);
  } catch {
    /* An unreadable build must be replaced, not treated as current. */
  }
  const identityPath = join(agentDir, 'worker-build.json');
  const updateReceiptPath = join(agentDir, 'data/worker-update.json');
  let installedDigest;
  let backup,
    snapshots,
    snapshotReady = false,
    rollbackFailed = false,
    servicesStarted = false,
    changed = false,
    restored = false;
  try {
    const manifest = await manifestFor(serverUrl);
    const target = manifest.targets?.[`${platform}-${arch}`];
    if (!target) throw new Error('No matching worker build is available for this computer.');
    const identity = readJson(identityPath);
    // macOS signing changes the downloaded bytes. Bind the manifest checksum to the sealed
    // file's digest, rather than comparing its signature bytes with the download forever.
    installedDigest = hadWorker ? digest(paths.executable) : undefined;
    const matchesBytes =
      installedDigest === target.sha256 ||
      (paths.app &&
        identity?.sha256 === target.sha256 &&
        identity?.version === manifest.version &&
        identity?.commit === manifest.commit &&
        identity?.installedSha256 === installedDigest);
    changed = !(
      before?.version === manifest.version &&
      (!manifest.commit || before?.commit === manifest.commit) &&
      matchesBytes
    );

    mkdirSync(agentDir, { recursive: true });
    backup = mkdtempSync(join(agentDir, '.worker-repair-'));
    // Preserve the entire sealed bundle, including the immutable supervisor and resource seal.
    // Copies (never hard links) survive codesign modifying a file in place.
    const files = [
      ...(paths.app ? [paths.app] : [paths.executable, paths.supervisor]),
      paths.previous,
      identityPath,
      updateReceiptPath,
      join(agentDir, 'code'),
    ];
    snapshots = files.map((path, i) => ({
      path,
      saved: join(backup, String(i)),
      existed: existsSync(path),
    }));
    for (const entry of snapshots)
      if (entry.existed)
        cpSync(entry.path, entry.saved, { recursive: true, preserveTimestamps: true });

    snapshotReady = true;

    if (changed) {
      // A full repair must boot the downloaded build, not an older installed code pointer.
      // The code directory is part of this transaction and is restored on failure.
      switchCodeBundle(agentDir, null);
      mkdirSync(dirname(paths.executable), { recursive: true });
      await download(serverUrl, paths.executable, manifest.version, paths.previous, {
        manifest,
        platform,
        arch,
        install,
      });
      if (paths.app) await seal(paths.app, { signSupervisor: false });
      // A previous automatic-update receipt names the old version. It must not make the new
      // supervisor reject readiness or restore an interrupted automatic update over this repair.
      rmSync(updateReceiptPath, { force: true });
    }
    servicesStarted = true;
    await restartServices({ rollback: false, changed });
    if (paths.app) {
      const staged = `${identityPath}.tmp`;
      const sealedIdentity = {
        version: manifest.version,
        commit: manifest.commit,
        sha256: target.sha256,
        installedSha256: digest(paths.executable),
      };
      if (JSON.stringify(identity) !== JSON.stringify(sealedIdentity)) {
        writeFileSync(staged, JSON.stringify(sealedIdentity), { mode: 0o600, flush: true });
        renameSync(staged, identityPath);
      }
      // A complete sealed bundle can be restored without needing codesign to work again.
      if (changed && snapshots[0].existed) {
        const previousApp = join(agentDir, 'worker-app.previous');
        rmSync(previousApp, { recursive: true, force: true });
        cpSync(snapshots[0].saved, previousApp, { recursive: true, preserveTimestamps: true });
      }
    }
    const fromVersion = before?.version || (hadWorker ? 'unknown' : 'not installed');
    const label = (info, sha256) =>
      before?.version === manifest.version
        ? `${info.version} (commit ${info.commit || 'unknown'}, sha256 ${sha256 || 'unknown'})`
        : info.version;
    print(
      changed
        ? `Worker build: ${label({ ...before, version: fromVersion }, installedDigest)} -> ${label(manifest, target.sha256)}.`
        : `Worker build: ${manifest.version} is already current.`,
    );
    return {
      version: manifest.version,
      previous: changed && hadWorker ? paths.previous : undefined,
      changed,
    };
  } catch (error) {
    if (snapshotReady) {
      try {
        for (const entry of snapshots) {
          rmSync(entry.path, { recursive: true, force: true });
          if (entry.existed) {
            mkdirSync(dirname(entry.path), { recursive: true });
            cpSync(entry.saved, entry.path, { recursive: true, preserveTimestamps: true });
          }
        }
        restored = true;
      } catch (restoreError) {
        rollbackFailed = true;
        // Keep the snapshot available for recovery if the filesystem itself prevented rollback.
        throw new Error(
          `${error.message} Worker rollback failed: ${restoreError.message}. Backup: ${backup}`,
          { cause: restoreError },
        );
      }
    }
    let restartError;
    if (servicesStarted && hadWorker && restored) {
      try {
        await restartServices({ rollback: true, changed });
      } catch (failure) {
        restartError = failure;
      }
    }
    throw new Error(
      `${error.message} ${hadWorker ? `The previous worker build ${restored ? 'was restored' : 'was kept'}.` : 'No previous worker build was installed.'}${restartError ? ` Service restart failed: ${restartError.message}` : ''}`,
      { cause: error },
    );
  } finally {
    if (backup && !rollbackFailed) rmSync(backup, { recursive: true, force: true });
    rmSync(`${identityPath}.tmp`, { force: true });
  }
}
