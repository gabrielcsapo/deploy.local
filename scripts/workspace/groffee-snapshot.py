#!/usr/bin/env python3
"""Read-only migration rehearsal input: SQLite backup, independent Git clones, verified LFS.

Never changes the source service or configures a destination control plane. The output
contains private account data and must remain owner-only. This is a migration snapshot,
not a complete service backup: authentication keys and running job workspaces are excluded.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
source, output = args.source.resolve(), args.output.resolve()
if output.exists() or output.is_relative_to(source) or source.is_relative_to(output):
    raise SystemExit('Choose a new destination outside the source data tree')
os.umask(0o077)
output.mkdir(parents=True, mode=0o700)
report = {'startedAt': time.time(), 'status': 'running', 'repositories': [], 'lfsObjects': 0,
          'lfsBytes': 0, 'exclusions': ['authentication keys', 'running job workspaces'],
          'cutoverReady': False}

def git(path, *arguments, trust=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_LFS_SKIP_SMUDGE='1')
    # Containers created some repositories as root. Trust only the explicitly
    # inventoried source path for this invocation, without changing Git settings.
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.directory=' + str(trust or path), '-C', str(path), *arguments],
                            capture_output=True, text=True, check=True, timeout=600, env=env)
    return result.stdout.strip()

def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

try:
    original = sqlite3.connect('file:' + str(source / 'groffee.sqlite') + '?mode=ro', uri=True)
    snapshot = sqlite3.connect(output / 'groffee.sqlite')
    original.backup(snapshot)
    original.close()
    assert snapshot.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'SQLite integrity failed'
    snapshot.row_factory = sqlite3.Row
    tables = ['users', 'repositories', 'issues', 'pull_requests', 'comments', 'diff_comments',
              'pipelines', 'pipeline_runs', 'pipeline_artifacts', 'lfs_objects', 'uploads',
              'personal_access_tokens', 'ssh_keys', 'repo_collaborators', 'repo_invites']
    report['counts'] = {name: snapshot.execute('SELECT count(*) FROM "' + name + '"').fetchone()[0]
                        for name in tables}
    report['numberCollisions'] = snapshot.execute('SELECT count(*) FROM issues i JOIN pull_requests p ON i.repo_id=p.repo_id AND i.number=p.number').fetchone()[0]
    report['unmappedPermissionRows'] = report['counts']['repo_collaborators'] + report['counts']['repo_invites']
    for repository in snapshot.execute('SELECT id,disk_path,default_branch FROM repositories'):
        recorded = Path(repository['disk_path'])
        relative = recorded.relative_to('/app/data') if recorded.is_absolute() else Path('repositories') / recorded
        path = (source / relative).resolve()
        assert path.is_relative_to(source / 'repositories'), 'Repository outside source storage'
        before = git(path, 'for-each-ref', '--format=%(refname) %(objectname)')
        target = output / 'repositories' / (repository['id'] + '.git')
        target.parent.mkdir(exist_ok=True)
        git(output, 'clone', '--mirror', '--no-local', '--template=', '--', str(path), str(target), trust=path)
        actual = git(target, 'for-each-ref', '--format=%(refname) %(objectname)')
        after = git(path, 'for-each-ref', '--format=%(refname) %(objectname)')
        assert before == actual == after, 'Repository changed during snapshot; retry with a fresh destination'
        git(target, 'fsck', '--full')
        git(target, 'config', '--remove-section', 'remote.origin')
        assert actual == git(target, 'for-each-ref', '--format=%(refname) %(objectname)'), 'Snapshot refs changed'
        report['repositories'].append({'id': repository['id'], 'refs': len(actual.splitlines()),
                                       'refsDigest': hashlib.sha256(actual.encode()).hexdigest()})
    seen = set()
    for object in snapshot.execute('SELECT oid,size FROM lfs_objects'):
        oid = object['oid']
        assert len(oid) == 64 and all(c in '0123456789abcdef' for c in oid), 'Invalid LFS identity'
        if oid in seen:
            continue
        seen.add(oid)
        relative = Path('lfs-objects') / oid[:2] / oid[2:4] / oid
        original_file, target = source / relative, output / relative
        assert original_file.is_file() and not original_file.is_symlink(), 'Missing LFS file'
        assert original_file.stat().st_size == object['size'], 'LFS size mismatch'
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original_file, target)
        assert file_hash(target) == oid, 'LFS digest mismatch'
        report['lfsObjects'] += 1
        report['lfsBytes'] += object['size']
    for directory in ['pipeline-artifacts', 'pipeline-logs', 'uploads', 'pages']:
        if (source / directory).exists():
            shutil.copytree(source / directory, output / directory, symlinks=True)
    snapshot.close()
    report['databaseDigest'] = file_hash(output / 'groffee.sqlite')
    report['status'] = 'verified'
except Exception as error:
    report['status'] = 'failed'
    report['error'] = str(error)
    raise
finally:
    report['completedAt'] = time.time()
    (output / 'snapshot-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ['status', 'lfsObjects', 'lfsBytes', 'cutoverReady']}))
