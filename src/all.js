#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn, spawnSync } = require("node:child_process")

function canWriteDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK)
      return true
    }
    fs.accessSync(path.dirname(dir), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

const LOGS_ROOT = canWriteDir("logs") ? "logs" : "logs-local"
const STATE_ROOT = canWriteDir("state") ? "state" : "state-local"
const RUN_TS = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
const LOGS_DIR = path.join(LOGS_ROOT, RUN_TS)
const FAILURES_FILE = path.join(LOGS_DIR, "failed-migrations.txt")
const SKIPPED_COMPLETED_FILE = path.join(LOGS_DIR, "skipped-completed.txt")
const STATE_DIR = STATE_ROOT
const COMPLETED_FILE = path.join(STATE_DIR, "completed-migrations.tsv")
const RSYNC_MARKER = "(rsync)"

function usage(commandName = "zfs-migrate all") {
  console.log(`Usage: ${commandName} [--dry-run] [--interactive] [--rsync-exclude <path>] [--rsync-delete] [--rsync-delete-excluded] [src-root dst-root]`)
  console.log(`Example: ${commandName} --dry-run`)
  console.log(`Example: ${commandName} /tank /jbod`)
  console.log(`Example: ${commandName} /jbod /tank`)
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    interactive: false,
    rsyncExcludes: [],
    rsyncDelete: false,
    rsyncDeleteExcluded: false,
    positionals: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === "--dry-run") {
      options.dryRun = true
    } else if (arg === "--interactive") {
      options.interactive = true
    } else if (arg === "--rsync-exclude") {
      i += 1
      if (!argv[i]) {
        throw new Error("--rsync-exclude requires a path")
      }
      options.rsyncExcludes.push(argv[i])
    } else if (arg.startsWith("--rsync-exclude=")) {
      const exclude = arg.slice("--rsync-exclude=".length)
      if (!exclude) {
        throw new Error("--rsync-exclude requires a path")
      }
      options.rsyncExcludes.push(exclude)
    } else if (arg === "--rsync-delete") {
      options.rsyncDelete = true
    } else if (arg === "--no-rsync-delete") {
      options.rsyncDelete = false
      options.rsyncDeleteExcluded = false
    } else if (arg === "--rsync-delete-excluded") {
      options.rsyncDelete = true
      options.rsyncDeleteExcluded = true
    } else if (arg === "--no-rsync-delete-excluded") {
      options.rsyncDeleteExcluded = false
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      options.positionals.push(arg)
    }
  }

  return options
}

function printSkipCompleted(src, marker, dryRun) {
  if (dryRun) {
    const reason = marker.startsWith("(rsync")
      ? "matching snapshotless completed-state marker exists"
      : "destination already fully matches source snapshots"
    console.log(`DRY RUN: would skip ${src}@${marker} because ${reason}`)
  } else {
    console.log(`SKIP completed: ${src}@${marker}`)
  }
}

function printMigrate(src, dst, dryRun, reason) {
  if (dryRun) {
    console.log(`DRY RUN: would migrate ${src} -> ${dst} because ${reason}`)
  } else {
    console.log(`=== MIGRATING ${src} -> ${dst} ===`)
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) {
    const err = (result.stderr || "").trim() || (result.error ? result.error.message : `${command} exited with status ${result.status}`)
    throw new Error(err)
  }
  return result.stdout.trimEnd()
}

function zfsGet(dataset, property) {
  return runCapture("zfs", ["get", "-H", "-o", "value", property, dataset]).trim()
}

function zfsGetOptional(dataset, property) {
  try {
    return zfsGet(dataset, property)
  } catch {
    return null
  }
}

function normalizeDatasetRoot(input) {
  return input.replace(/^\/+/, "").replace(/\/+$/, "")
}

function datasetToDest(src, srcRoot, dstRoot) {
  if (src === srcRoot) {
    return dstRoot
  }

  if (!src.startsWith(`${srcRoot}/`)) {
    throw new Error(`Source dataset must be in ${srcRoot}/: ${src}`)
  }

  return `${dstRoot}/${src.slice(srcRoot.length + 1)}`
}

function snapshotNames(dataset) {
  const output = runCapture("zfs", ["list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation", "-r", dataset])
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith(`${dataset}@`))
    .map((line) => line.slice(line.indexOf("@") + 1))
}

function latestSnapshotName(dataset) {
  const names = snapshotNames(dataset)
  return names.length === 0 ? null : names[names.length - 1]
}

function collectSnapshotMetadata(datasets) {
  return datasets.map((src) => ({
    src,
    latestSnapshot: latestSnapshotName(src),
  }))
}

function datasetExists(dataset) {
  const result = spawnSync("zfs", ["list", "-H", dataset], { stdio: "ignore" })
  return result.status === 0
}

function mountpointForRsync(dataset) {
  const type = zfsGet(dataset, "type")
  if (type !== "filesystem") {
    throw new Error(`Cannot use rsync migration for ${dataset}: ZFS type is ${type}, not filesystem`)
  }

  const mountpoint = zfsGet(dataset, "mountpoint")
  if (!mountpoint || mountpoint === "none" || mountpoint === "legacy") {
    throw new Error(`Cannot use rsync migration for ${dataset}: mountpoint is ${mountpoint}`)
  }

  return mountpoint
}

function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function sourceMountpointForRsync(dataset) {
  const mountpoint = mountpointForRsync(dataset)
  const mounted = zfsGetOptional(dataset, "mounted")

  if (mounted && mounted !== "yes") {
    throw new Error(`Cannot rsync ${dataset}: source mountpoint ${mountpoint} is not mounted`)
  }

  if (!directoryExists(mountpoint)) {
    throw new Error(`Cannot rsync ${dataset}: source mountpoint ${mountpoint} does not exist or is not a directory`)
  }

  return mountpoint
}

function listChildDatasets(dataset) {
  const output = runCapture("zfs", ["list", "-H", "-o", "name", "-r", dataset])
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => name !== dataset)
}

function childMountExcludes(dataset, parentMount) {
  return listChildDatasets(dataset)
    .map((child) => {
      try {
        return mountpointForRsync(child)
      } catch {
        return null
      }
    })
    .filter((mountpoint) => mountpoint && mountpoint.startsWith(`${parentMount}/`))
    .map((mountpoint) => `${mountpoint.slice(parentMount.length + 1)}/`)
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "") || "/"
}

function unique(values) {
  return [...new Set(values)]
}

function normalizeRsyncExclude(srcMount, exclude) {
  const trimmed = exclude.trim()
  if (!trimmed) {
    throw new Error("Rsync exclude paths cannot be empty")
  }

  if (!trimmed.startsWith("/")) {
    return trimmed
  }

  const normalizedSrcMount = stripTrailingSlashes(srcMount)
  const normalizedExclude = stripTrailingSlashes(trimmed)
  if (normalizedExclude === normalizedSrcMount) {
    throw new Error(`Refusing to exclude the entire source mount: ${trimmed}`)
  }

  if (!normalizedExclude.startsWith(`${normalizedSrcMount}/`)) {
    return null
  }

  return normalizedExclude.slice(normalizedSrcMount.length + 1)
}

function normalizeRsyncExcludes(srcMount, excludes) {
  return unique(excludes.map((exclude) => normalizeRsyncExclude(srcMount, exclude)).filter(Boolean))
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value
  }

  return `'${value.replaceAll("'", "'\\''")}'`
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ")
}

function rsyncArgs(srcMount, dstMount, childExcludes, userExcludes, rsyncDelete, rsyncDeleteExcluded) {
  const args = [
    "-aHAXx",
    "--numeric-ids",
    "--no-inc-recursive",
    "--verbose",
    "--info=progress2",
  ]

  if (rsyncDelete || rsyncDeleteExcluded) {
    args.push("--delete")
  }

  if (rsyncDeleteExcluded) {
    args.push("--delete-excluded")
  }

  for (const exclude of childExcludes) {
    args.push("--filter", `H ${exclude}`, "--filter", `P ${exclude}`)
  }

  for (const exclude of userExcludes) {
    args.push("--exclude", exclude)
  }

  args.push(`${srcMount}/`, `${dstMount}/`)
  return args
}

function rsyncPlan(src, dst, rsyncOptions) {
  const srcMount = sourceMountpointForRsync(src)
  const dstMount = plannedMountpointForRsync(dst)
  const childExcludes = childMountExcludes(src, srcMount)
  const userExcludes = normalizeRsyncExcludes(srcMount, rsyncOptions.rsyncExcludes)
  const args = rsyncArgs(
    srcMount,
    dstMount,
    childExcludes,
    userExcludes,
    rsyncOptions.rsyncDelete,
    rsyncOptions.rsyncDeleteExcluded,
  )

  return { srcMount, dstMount, childExcludes, userExcludes, args }
}

function rsyncCompletionMarker(src, rsyncOptions) {
  const srcMount = mountpointForRsync(src)
  const userExcludes = normalizeRsyncExcludes(srcMount, rsyncOptions.rsyncExcludes).sort()

  if (userExcludes.length === 0 && !rsyncOptions.rsyncDelete && !rsyncOptions.rsyncDeleteExcluded) {
    return RSYNC_MARKER
  }

  const signature = {
    version: 1,
    childMountExclusion: "hide-protect-filters-v1",
    args: ["-aHAXx", "--numeric-ids", "--no-inc-recursive", "--verbose", "--info=progress2"],
    rsyncDelete: Boolean(rsyncOptions.rsyncDelete),
    rsyncDeleteExcluded: Boolean(rsyncOptions.rsyncDeleteExcluded),
    userExcludes,
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(signature)).digest("hex").slice(0, 12)
  return `(rsync:${hash})`
}

function plannedMountpointForRsync(dataset) {
  if (datasetExists(dataset)) {
    return mountpointForRsync(dataset)
  }

  let parent = dataset
  while (parent.includes("/")) {
    parent = parent.slice(0, parent.lastIndexOf("/"))
    if (datasetExists(parent)) {
      const parentMount = mountpointForRsync(parent)
      const suffix = dataset.slice(parent.length + 1).split("/")
      return path.posix.join(parentMount, ...suffix)
    }
  }

  throw new Error(`Cannot determine planned mountpoint for missing destination dataset: ${dataset}`)
}

function printRsyncDryRunPlan(src, dst, marker, plan) {
  console.log(`DRY RUN: would run rsync ${src} -> ${dst} because no matching snapshotless completion marker exists (${marker})`)
  console.log(`  Source mount: ${plan.srcMount}`)
  console.log(`  Target mount: ${plan.dstMount}`)
  if (plan.childExcludes.length > 0) {
    console.log(`  Child dataset protections: ${plan.childExcludes.join(", ")}`)
  }
  if (plan.userExcludes.length > 0) {
    console.log(`  User excludes: ${plan.userExcludes.join(", ")}`)
  }
  console.log(`  Command: ${formatCommand("sudo", ["rsync", ...plan.args])}`)
}

function verifySnapshotMigration(src, dst, latestSnapshot) {
  if (!datasetExists(dst)) {
    return { ok: false, marker: latestSnapshot }
  }

  const srcSnapshots = snapshotNames(src)
  const dstSnapshots = snapshotNames(dst)
  const ok = srcSnapshots.length === dstSnapshots.length && srcSnapshots.every((snap, idx) => snap === dstSnapshots[idx])
  return { ok, marker: latestSnapshot }
}

function sanitizeDatasetName(dataset) {
  return dataset.replaceAll("/", "__")
}

function appendLine(file, line) {
  fs.appendFileSync(file, `${line}\n`)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function loadCompletedRecords() {
  if (!fs.existsSync(COMPLETED_FILE)) {
    return []
  }
  return fs
    .readFileSync(COMPLETED_FILE, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t")
      return {
        src: parts[0],
        dst: parts[1] || "",
        marker: parts[2] || "",
        runTs: parts[3] || "",
        logFile: parts[4] || "",
      }
    })
}

function saveCompletedRecords(records) {
  const body = records
    .map((record) => [record.src, record.dst, record.marker, record.runTs, record.logFile].join("\t"))
    .join("\n")
  fs.writeFileSync(COMPLETED_FILE, body ? `${body}\n` : "")
}

function hasCompletedRecord(records, src, dst, marker) {
  return records.some((record) => record.src === src && record.dst === dst && record.marker === marker)
}

function upsertCompletedRecord(records, src, dst, marker, logFile) {
  return [
    ...records.filter((record) => !(record.src === src && record.dst === dst)),
    {
      src,
      dst,
      marker,
      runTs: RUN_TS,
      logFile,
    },
  ]
}

function runMigration(src, dst, logFile, dryRun, interactive, rsyncOptions) {
  if (dryRun) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const childArgs = [process.execPath, path.join(__dirname, "vol.js")]
    if (!interactive) {
      childArgs.push("--destroy-if-exists")
    }
    for (const exclude of rsyncOptions.rsyncExcludes) {
      childArgs.push("--rsync-exclude", exclude)
    }
    if (rsyncOptions.rsyncDeleteExcluded) {
      childArgs.push("--rsync-delete-excluded")
    } else if (rsyncOptions.rsyncDelete) {
      childArgs.push("--rsync-delete")
    }
    childArgs.push(src, dst)

    const child = spawn("sudo", childArgs, {
      stdio: ["inherit", "pipe", "pipe"],
    })
    const logStream = fs.createWriteStream(logFile, { flags: "a" })

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk)
      logStream.write(chunk)
    })

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk)
      logStream.write(chunk)
    })

    child.on("error", (error) => {
      const msg = `${error.message}\n`
      process.stderr.write(msg)
      logStream.write(msg)
      logStream.end(() => resolve(false))
    })

    child.on("exit", (code) => {
      logStream.end(() => resolve(code === 0))
    })
  })
}

async function main(argv = process.argv.slice(2), { commandName = "zfs-migrate all" } = {}) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    usage(commandName)
    throw error
  }

  const {
    dryRun,
    interactive,
    rsyncExcludes,
    rsyncDelete,
    rsyncDeleteExcluded,
    positionals,
  } = parsed

  if (positionals.length !== 0 && positionals.length !== 2) {
    usage(commandName)
    throw new Error("Pass either no roots for tank -> jbod defaults, or both src-root and dst-root.")
  }

  const srcRoot = normalizeDatasetRoot(positionals[0] || "tank")
  const dstRoot = normalizeDatasetRoot(positionals[1] || "jbod")
  if (!srcRoot || !dstRoot) {
    throw new Error("Source and destination roots cannot be empty.")
  }
  if (srcRoot === dstRoot) {
    throw new Error("Source and destination roots must be different.")
  }

  const rsyncOptions = { rsyncExcludes, rsyncDelete, rsyncDeleteExcluded }

  if (!dryRun) {
    ensureDir(LOGS_DIR)
    ensureDir(STATE_DIR)
    if (!fs.existsSync(COMPLETED_FILE)) {
      fs.writeFileSync(COMPLETED_FILE, "")
    }
  }

  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`)
  console.log(`Prompting: ${interactive ? "interactive" : "auto-destroy"}`)
  console.log(`Source root: ${srcRoot}`)
  console.log(`Target root: ${dstRoot}`)
  console.log(`Logs: ${LOGS_DIR}`)
  console.log(`State: ${STATE_DIR}`)
  if (rsyncExcludes.length > 0) {
    console.log(`Rsync excludes: ${rsyncExcludes.join(", ")}`)
  }
  if (rsyncDeleteExcluded) {
    console.log("Rsync delete: enabled, including excluded paths")
  } else if (rsyncDelete) {
    console.log("Rsync delete: enabled")
  } else {
    console.log("Rsync delete: disabled")
  }

  const datasets = runCapture("zfs", ["list", "-H", "-o", "name", "-r", srcRoot])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((dataset) => dataset !== srcRoot)
    .sort()
  const snapshotMetadata = collectSnapshotMetadata(datasets)

  let completedRecords = loadCompletedRecords()

  for (const { src, latestSnapshot } of snapshotMetadata) {
    const dst = datasetToDest(src, srcRoot, dstRoot)
    const logFile = path.join(LOGS_DIR, `${sanitizeDatasetName(src)}.log`)

    if (!latestSnapshot) {
      const marker = rsyncCompletionMarker(src, rsyncOptions)
      if (hasCompletedRecord(completedRecords, src, dst, marker)) {
        printSkipCompleted(src, marker, dryRun)
        if (!dryRun) {
          appendLine(SKIPPED_COMPLETED_FILE, `${src}\t${dst}\t${marker}`)
        }
        continue
      }

      if (dryRun) {
        try {
          printRsyncDryRunPlan(src, dst, marker, rsyncPlan(src, dst, rsyncOptions))
        } catch (error) {
          console.log(`DRY RUN: cannot run rsync ${src} -> ${dst}: ${error.message}`)
        }
        continue
      }

      console.log(`=== RSYNC MIGRATING ${src} -> ${dst} ===`)
      const ok = await runMigration(src, dst, logFile, dryRun, interactive, rsyncOptions)
      if (!ok) {
        console.log(`FAILED: ${src}`)
        appendLine(FAILURES_FILE, `${src}\t${dst}\t${logFile}`)
        continue
      }

      console.log(`OK: ${src}`)
      completedRecords = upsertCompletedRecord(completedRecords, src, dst, marker, logFile)
      saveCompletedRecords(completedRecords)
      continue
    }

    const preflight = verifySnapshotMigration(src, dst, latestSnapshot)

    if (preflight.ok) {
      printSkipCompleted(src, preflight.marker, dryRun)
      if (!dryRun) {
        appendLine(SKIPPED_COMPLETED_FILE, `${src}\t${dst}\t${preflight.marker}`)
        if (!hasCompletedRecord(completedRecords, src, dst, preflight.marker)) {
          completedRecords = upsertCompletedRecord(completedRecords, src, dst, preflight.marker, logFile)
          saveCompletedRecords(completedRecords)
        }
      }
      continue
    }

    printMigrate(src, dst, dryRun, "destination is missing snapshots or does not fully match source")

    const ok = await runMigration(src, dst, logFile, dryRun, interactive, rsyncOptions)
    if (!ok) {
      console.log(`FAILED: ${src}`)
      if (!dryRun) {
        appendLine(FAILURES_FILE, `${src}\t${dst}\t${logFile}`)
      }
      continue
    }

    if (dryRun) {
      continue
    }

    const finalLatestSnapshot = latestSnapshotName(src)
    const postflight = verifySnapshotMigration(src, dst, finalLatestSnapshot)
    if (!postflight.ok) {
      const msg = "Post-migration verification failed: destination does not fully match source.\n"
      process.stderr.write(msg)
      fs.appendFileSync(logFile, msg)
      console.log(`FAILED: ${src}`)
      appendLine(FAILURES_FILE, `${src}\t${dst}\t${logFile}`)
      continue
    }

    console.log(`OK: ${src}`)
    completedRecords = upsertCompletedRecord(completedRecords, src, dst, postflight.marker, logFile)
    saveCompletedRecords(completedRecords)
  }
}

module.exports = {
  main,
  parseArgs,
  normalizeDatasetRoot,
  datasetToDest,
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  })
}
