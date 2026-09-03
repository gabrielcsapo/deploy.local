import { mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { deployDataPath } from './data-directory.ts';

const VOLUMES_DIR = deployDataPath('volumes');
const BACKUPS_DIR = deployDataPath('backups');

// ── Directory Management ────────────────────────────────────────────────────

export function ensureVolumeDirs() {
  if (!existsSync(VOLUMES_DIR)) mkdirSync(VOLUMES_DIR, { recursive: true });
  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
}

export function getVolumeDir(deploymentName: string): string {
  ensureVolumeDirs();
  const volumeDir = resolve(VOLUMES_DIR, deploymentName);

  // Auto-create on first access
  if (!existsSync(volumeDir)) {
    mkdirSync(volumeDir, { recursive: true });
    mkdirSync(resolve(volumeDir, 'data'), { recursive: true });
    mkdirSync(resolve(volumeDir, 'uploads'), { recursive: true });
  }

  return volumeDir;
}

export function getBackupDir(deploymentName: string): string {
  ensureVolumeDirs();
  const backupDir = resolve(BACKUPS_DIR, deploymentName);
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

// ── Backup Operations ───────────────────────────────────────────────────────

export function createBackup(
  deploymentName: string,
  label?: string,
  onProgress?: (progress: { processedBytes: number; totalBytes: number }) => void,
): Promise<{ filename: string; sizeBytes: number; timestamp: string; volumeSizeBytes: number }> {
  const volumeDir = getVolumeDir(deploymentName);
  const backupDir = getBackupDir(deploymentName);
  const volumeSizeBytes = getVolumeSize(deploymentName);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const labelSuffix = label ? `-${label.replace(/[^a-zA-Z0-9-]/g, '_')}` : '';
  const filename = `${timestamp}${labelSuffix}.tar.gz`;
  const backupPath = resolve(backupDir, filename);

  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-czf', backupPath, '-C', volumeDir, 'data', 'uploads'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const reportProgress = () => {
      let processedBytes = 0;
      try {
        processedBytes = statSync(backupPath).size;
      } catch {
        // tar has not created the archive yet
      }
      onProgress?.({ processedBytes, totalBytes: volumeSizeBytes });
    };
    reportProgress();
    const progressTimer = setInterval(reportProgress, 1000);
    progressTimer.unref();

    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearInterval(progressTimer);
      reject(new Error(`Backup failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearInterval(progressTimer);
      if (code !== 0) {
        reject(new Error(`Backup failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        const stats = statSync(backupPath);
        onProgress?.({ processedBytes: stats.size, totalBytes: volumeSizeBytes });
        resolve({
          filename,
          sizeBytes: stats.size,
          timestamp: new Date().toISOString(),
          volumeSizeBytes,
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function restoreBackup(deploymentName: string, filename: string): void {
  if (basename(filename) !== filename) throw new Error('Invalid backup filename');
  const volumeDir = getVolumeDir(deploymentName);
  const backupDir = getBackupDir(deploymentName);
  const backupPath = resolve(backupDir, filename);

  if (!existsSync(backupPath)) {
    throw new Error('Backup file not found');
  }

  // Clear existing volumes (REPLACE strategy)
  rmSync(volumeDir, { recursive: true, force: true });
  mkdirSync(volumeDir, { recursive: true });

  // Extract tarball
  execSync(`tar -xzf ${JSON.stringify(backupPath)} -C ${JSON.stringify(volumeDir)}`, {
    stdio: 'pipe',
  });
}

export function listBackupFiles(deploymentName: string) {
  const backupDir = getBackupDir(deploymentName);
  if (!existsSync(backupDir)) return [];

  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((filename) => {
      const stats = statSync(resolve(backupDir, filename));
      return {
        filename,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  return files;
}

export function deleteBackupFile(deploymentName: string, filename: string): void {
  if (basename(filename) !== filename) throw new Error('Invalid backup filename');
  const backupPath = resolve(getBackupDir(deploymentName), filename);
  if (existsSync(backupPath)) {
    // Legacy backups are tarballs; graph recovery points are directories that
    // contain one verified archive per managed graph volume plus a manifest.
    rmSync(backupPath, { recursive: true, force: true });
  }
}

// ── Volume Lifecycle ────────────────────────────────────────────────────────

export function deleteVolumes(deploymentName: string): void {
  const volumeDir = resolve(VOLUMES_DIR, deploymentName);

  // Only delete volumes, NOT backups (user preference)
  if (existsSync(volumeDir)) rmSync(volumeDir, { recursive: true, force: true });
}

export function getVolumeSize(deploymentName: string): number {
  const volumeDir = getVolumeDir(deploymentName);

  try {
    const result = execSync(`du -sb ${JSON.stringify(volumeDir)}`, { stdio: 'pipe' })
      .toString()
      .trim();
    return parseInt(result.split('\t')[0], 10);
  } catch {
    return 0;
  }
}
