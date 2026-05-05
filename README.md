# tank-migrate

CLI helpers for migrating ZFS datasets from `tank` to `jbod`.

## Behavior

- If a source dataset has snapshots, migration uses `zfs send` and `zfs receive`.
- If a source dataset has no snapshots, migration falls back to `rsync`.
- The tool does not create source-side snapshots automatically.
- `migrate-all` skips datasets only when the destination already fully matches the source.

## Commands

Run directly with Node:

```bash
node migrate-all.js --dry-run
node migrate-all.js --interactive
node migrate-zfs-vol.js tank/apps/api
```

Or install locally as npm bins:

```bash
npm install
npx migrate-all --dry-run
npx migrate-zfs-vol tank/apps/api
```

## Options

### `migrate-all.js`

- `--dry-run`: show what would happen without changing ZFS state
- `--interactive`: do not auto-destroy existing snapshot-based destinations; prompt per dataset instead

### `migrate-zfs-vol.js`

- `--dry-run`: show what would happen without changing ZFS state
- `--destroy-if-exists`: non-interactive replace mode for snapshot-based destinations

## Notes

- The tools assume source datasets live under `tank` and destination datasets mirror under `jbod`.
- Snapshotless datasets require `rsync` and mounted filesystem datasets.
- `zvol`s without snapshots cannot use the `rsync` fallback.
