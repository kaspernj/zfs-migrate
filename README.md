# zfs-migrate

CLI helpers for migrating ZFS datasets between pools.

## Behavior

- If a source dataset has snapshots, migration uses `zfs send` and `zfs receive`.
- If a source dataset has no snapshots, migration falls back to `rsync`.
- The tool does not create source-side snapshots automatically.
- `zfs-migrate all` skips snapshot-based datasets when snapshots match, and skips snapshotless datasets when a matching completed-state marker exists.
- Encrypted snapshot-based datasets use raw `zfs send -w`, preserving native ZFS encryption.
- Encrypted snapshotless datasets create an encrypted destination before rsync and prompt for a destination key/passphrase when needed.

## Commands

Use through npm/npx:

```bash
npx zfs-migrate vol /tank/apps/api /jbod/apps/api
npx zfs-migrate vol /jbod/apps/api /tank/apps/api
npx zfs-migrate all /tank /jbod --dry-run
npx zfs-migrate all /tank /jbod --interactive
npx zfs-migrate all /tank /jbod --rsync-exclude /tank/media/cache --rsync-delete-excluded
```

After installing locally:

```bash
npm install
zfs-migrate vol /tank/apps/api /jbod/apps/api
zfs-migrate all /tank /jbod --dry-run
```

When the destination is omitted for `vol`, `tank/foo/bar` maps to `jbod/foo/bar`.
For non-`tank` sources, pass an explicit destination.

Dataset arguments may be written as `tank/apps/api` or `/tank/apps/api`; leading slashes are normalized away because ZFS dataset names are not filesystem paths.

`zfs-migrate all` invokes the per-dataset migrator through Node, so bulk runs do not depend on the JS files having executable bits set.

## Options

### `zfs-migrate all`

- `--dry-run`: show what would happen without changing ZFS state
- `--interactive`: do not auto-destroy existing snapshot-based destinations; prompt per dataset instead
- `--rsync-exclude <path>`: exclude a path from snapshotless rsync migration; can be passed multiple times
- `--rsync-delete`: delete destination files that are not present on the source during snapshotless rsync
- `--rsync-delete-excluded`: delete destination files that match `--rsync-exclude` during snapshotless rsync
- `--no-rsync-delete`: disable rsync delete again if a wrapper enabled it earlier
- `--no-rsync-delete-excluded`: disable excluded-file deletion again if a wrapper enabled it earlier

`zfs-migrate all` defaults to `tank -> jbod` when roots are omitted. Pass both roots to migrate between other pools:

```bash
zfs-migrate all /jbod /tank
```

### `zfs-migrate vol`

- `--dry-run`: show what would happen without changing ZFS state
- `--destroy-if-exists`: non-interactive replace mode for snapshot-based destinations
- `--rsync-exclude <path>`: exclude a path from snapshotless rsync migration; can be passed multiple times
- `--rsync-delete`: delete destination files that are not present on the source during snapshotless rsync
- `--rsync-delete-excluded`: delete destination files that match `--rsync-exclude` during snapshotless rsync
- `--no-rsync-delete`: disable rsync delete again if a wrapper enabled it earlier
- `--no-rsync-delete-excluded`: disable excluded-file deletion again if a wrapper enabled it earlier

Rsync excludes can be normal rsync patterns or absolute paths under the source mount.
For example, when migrating `tank/media`, this excludes a cache tree:

```bash
zfs-migrate all /tank /jbod \
  --rsync-exclude "/tank/media/cache" \
  --rsync-delete-excluded
```

`--rsync-delete-excluded` is intentionally separate from `--rsync-exclude`: excluding prevents future copies, while delete-excluded also removes matching files that were already copied to the destination.

`zfs-migrate all --dry-run` does not run rsync or `rsync --dry-run`, because either mode can require a full source and destination tree scan.
For snapshotless datasets, dry-run prints the live rsync command that would be run.

## Development

```bash
npm run syntax
npm run lint
npm test
npm run check
```

`npm run check` runs syntax checks, ESLint, and Jasmine.

## Notes

- `zfs-migrate all` supports arbitrary source and destination roots when both are passed explicitly.
- `zfs-migrate vol` supports arbitrary source and destination datasets when both are passed explicitly.
- Snapshotless datasets require `rsync` and mounted filesystem datasets.
- If a snapshotless encrypted source already has an unencrypted destination, `zfs-migrate vol` refuses to rsync unless `--destroy-if-exists` is used to recreate the destination.
- Snapshotless source mountpoints must already be mounted and present; the tools do not create source directories or mount source datasets automatically.
- Snapshotless parent filesystem rsyncs exclude child ZFS dataset mountpoints so those child datasets are migrated separately.
- Snapshotless parent filesystem rsyncs protect child ZFS dataset mountpoints from deletion, even when `--rsync-delete-excluded` is enabled.
- Snapshotless rsync fallback does not use delete options unless explicitly requested.
- Snapshotless `zfs-migrate all` runs rsync at most once per dataset; rsync exit status is the completion signal.
- Snapshotless rsync builds a full file list before transfer so overall progress and speed are meaningful.
- Snapshotless rsync migration is verbose and shows filenames while it works.
- `zvol`s without snapshots cannot use the `rsync` fallback.
- `rsync` must be installed for live snapshotless migration.
- If any snapshotless datasets need live migration and `rsync` is missing, `zfs-migrate all` fails before starting that dataset.
