#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process")
const readline = require("node:readline/promises")
const fs = require("node:fs")
const path = require("node:path")
const { stdin, stdout, stderr, exit } = require("node:process")

function usage(commandName = "zfs-migrate vol") {
  console.log(`Usage: ${commandName} [--dry-run] [--destroy-if-exists] [--rsync-exclude <path>] [--rsync-delete] [--rsync-delete-excluded] <src-dataset|legacy-name> [dst-dataset]`)
  console.log(`Example: ${commandName} tank/apps/api`)
  console.log(`Example: ${commandName} /tank/apps/api /jbod/apps/api`)
  console.log(`Example: ${commandName} /jbod/apps/api /tank/apps/api`)
  console.log(`Example: ${commandName} --destroy-if-exists demo-production`)
}

function parseArgs(argv) {
  const options = {
    destroyIfExists: false,
    dryRun: false,
    rsyncExcludes: [],
    rsyncDelete: false,
    rsyncDeleteExcluded: false,
    positionals: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === "--destroy-if-exists") {
      options.destroyIfExists = true
    } else if (arg === "--dry-run") {
      options.dryRun = true
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

function normalizeDatasetInput(input) {
  return input.replace(/^\/+/, "").replace(/\/+$/, "")
}

function resolveDatasets(srcInput, dstInput) {
  const normalizedSrcInput = normalizeDatasetInput(srcInput)
  const normalizedDstInput = dstInput ? normalizeDatasetInput(dstInput) : null
  const srcIsDatasetPath = srcInput.startsWith("/") || normalizedSrcInput.includes("/")

  if (normalizedDstInput) {
    const src = srcIsDatasetPath ? normalizedSrcInput : `tank/backups/${normalizedSrcInput}`
    return { src, dst: normalizedDstInput }
  }

  if (srcIsDatasetPath && !normalizedSrcInput.startsWith("tank/")) {
    throw new Error(`Destination dataset is required when source is not under tank/: ${normalizedSrcInput}`)
  }

  const src = srcIsDatasetPath ? normalizedSrcInput : `tank/backups/${normalizedSrcInput}`
  const dst = normalizedDstInput || `jbod/${src.slice("tank/".length)}`
  return { src, dst }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) {
    const err = (result.stderr || "").trim() || (result.error ? result.error.message : `${command} exited with status ${result.status}`)
    throw new Error(err)
  }
  return result.stdout.trimEnd()
}

function commandExists(command) {
  const result = spawnSync("which", [command], { stdio: "ignore" })
  return result.status === 0
}

function ensureRsyncAvailable(context) {
  if (!commandExists("rsync")) {
    throw new Error(`rsync is required for ${context}, but it is not installed or not in PATH`)
  }
}

function runInherit(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

function datasetExists(dataset) {
  const result = spawnSync("zfs", ["list", "-H", dataset], { stdio: "ignore" })
  return result.status === 0
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

function sourceEncryptionInfo(dataset) {
  const encryption = zfsGet(dataset, "encryption")
  const encryptionroot = zfsGetOptional(dataset, "encryptionroot")
  const keyDataset = encryptionroot && encryptionroot !== "-" ? encryptionroot : dataset

  return {
    encrypted: encryption !== "off",
    encryption,
    encryptionroot,
    keyformat: zfsGetOptional(keyDataset, "keyformat"),
    keylocation: zfsGetOptional(keyDataset, "keylocation"),
  }
}

function isReusableKeylocation(keylocation) {
  return Boolean(keylocation && keylocation !== "-" && keylocation !== "none" && keylocation !== "prompt")
}

function encryptionCreateOptions(encryptionInfo) {
  if (!encryptionInfo.encrypted) {
    return []
  }

  const keyformat = encryptionInfo.keyformat && encryptionInfo.keyformat !== "none"
    ? encryptionInfo.keyformat
    : "passphrase"
  const keylocation = isReusableKeylocation(encryptionInfo.keylocation)
    ? encryptionInfo.keylocation
    : "prompt"

  return [
    "-o", `encryption=${encryptionInfo.encryption}`,
    "-o", `keyformat=${keyformat}`,
    "-o", `keylocation=${keylocation}`,
  ]
}

function describeEncryptionCreate(encryptionInfo) {
  if (!encryptionInfo.encrypted) {
    return "unencrypted"
  }

  const options = encryptionCreateOptions(encryptionInfo)
  return options
    .filter((_, index) => index % 2 === 1)
    .join(" ")
}

function createDestinationFilesystem(dst, encryptionInfo, dryRun) {
  const encryptionOptions = encryptionCreateOptions(encryptionInfo)
  const createArgs = ["zfs", "create", "-p", ...encryptionOptions, dst]

  if (dryRun) {
    console.log(`Would create destination filesystem: ${formatCommand("sudo", createArgs)}`)
    return
  }

  if (encryptionInfo.encrypted) {
    console.log(`Creating encrypted destination filesystem: ${dst}`)
    console.log(`Encryption options: ${describeEncryptionCreate(encryptionInfo)}`)
    if (!isReusableKeylocation(encryptionInfo.keylocation)) {
      console.log("ZFS will prompt for the destination encryption key/passphrase.")
    }
  } else {
    console.log(`Creating destination filesystem: ${dst}`)
  }

  runInherit("sudo", createArgs)
}

function validateOrRecreateSnapshotlessDestination(dst, encryptionInfo, destroyIfExists, dryRun) {
  if (!datasetExists(dst)) {
    createDestinationFilesystem(dst, encryptionInfo, dryRun)
    return
  }

  if (!encryptionInfo.encrypted) {
    return
  }

  const dstEncryption = zfsGet(dst, "encryption")
  if (dstEncryption === encryptionInfo.encryption) {
    return
  }

  const message = `Destination ${dst} has encryption=${dstEncryption}, but source has encryption=${encryptionInfo.encryption}.`
  if (!destroyIfExists) {
    throw new Error(`${message} Re-run with --destroy-if-exists to recreate the destination before rsync.`)
  }

  if (dryRun) {
    console.log(`${message} Would destroy and recreate destination because --destroy-if-exists is set.`)
    console.log(`Would destroy destination: ${dst}`)
    createDestinationFilesystem(dst, encryptionInfo, true)
    return
  }

  console.log(`${message} Destroying and recreating destination because --destroy-if-exists is set.`)
  runInherit("sudo", ["zfs", "destroy", "-r", dst])
  createDestinationFilesystem(dst, encryptionInfo, false)
}

function listDirectSnapshots(dataset) {
  const output = runCapture("zfs", ["list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation", "-r", dataset])
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith(`${dataset}@`))
}

function snapshotName(fullName) {
  return fullName.slice(fullName.indexOf("@") + 1)
}

function getSendSize(args) {
  const output = runCapture("sudo", ["zfs", "send", "-nP", ...args])
  const sizeLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("size"))

  if (!sizeLine) {
    throw new Error("Could not calculate stream size")
  }

  const [, size] = sizeLine.split(/\s+/)
  return Number(size)
}

function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      if (signal) {
        reject(new Error(`${label} terminated by signal ${signal}`))
        return
      }
      reject(new Error(`${label} exited with status ${code}`))
    })
  })
}

async function runPipeline(sendArgs, pvSize, recvArgs) {
  const sender = spawn("sudo", ["zfs", "send", ...sendArgs], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  const progress = spawn("pv", ["-f", "-s", String(pvSize)], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  const receiver = spawn("sudo", ["zfs", "receive", ...recvArgs], {
    stdio: ["pipe", "inherit", "inherit"],
  })

  sender.stdout.pipe(progress.stdin)
  progress.stdout.pipe(receiver.stdin)

  await Promise.all([
    waitForChild(sender, "zfs send"),
    waitForChild(progress, "pv"),
    waitForChild(receiver, "zfs receive"),
  ])
}

async function promptChoice(destroyIfExists) {
  if (destroyIfExists) {
    console.log("Choice: DESTROY (set by --destroy-if-exists)")
    return "DESTROY"
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    return (await rl.question("Choice: ")).trim()
  } finally {
    rl.close()
  }
}

function mountpointForRsync(dataset) {
  const type = zfsGet(dataset, "type")
  if (type !== "filesystem") {
    throw new Error(`Cannot use rsync fallback for ${dataset}: ZFS type is ${type}, not filesystem`)
  }

  const mountpoint = zfsGet(dataset, "mountpoint")
  if (!mountpoint || mountpoint === "none" || mountpoint === "legacy") {
    throw new Error(`Cannot use rsync fallback for ${dataset}: mountpoint is ${mountpoint}`)
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

function runRsync(srcMount, dstMount, childExcludes, userExcludes, dryRun, rsyncDelete, rsyncDeleteExcluded) {
  const args = rsyncArgs(srcMount, dstMount, childExcludes, userExcludes, rsyncDelete, rsyncDeleteExcluded)
  if (dryRun) {
    console.log(`Would run rsync: ${formatCommand("sudo", ["rsync", ...args])}`)
    return
  }

  ensureRsyncAvailable(`migrating snapshotless dataset from ${srcMount} to ${dstMount}`)
  runInherit("sudo", ["rsync", ...args])
}

async function main(argv = process.argv.slice(2), { commandName = "zfs-migrate vol" } = {}) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    usage(commandName)
    throw error
  }

  const {
    destroyIfExists,
    dryRun,
    rsyncExcludes,
    rsyncDelete,
    rsyncDeleteExcluded,
    positionals: args,
  } = parsed

  if (args.length < 1 || args.length > 2) {
    usage(commandName)
    exit(1)
  }

  const { src, dst } = resolveDatasets(args[0], args[1])
  const dstParent = dst.includes("/") ? dst.slice(0, dst.lastIndexOf("/")) : dst

  if (!datasetExists(src)) {
    throw new Error(`Source dataset does not exist: ${src}`)
  }

  const snapshots = listDirectSnapshots(src)
  const encryptionInfo = sourceEncryptionInfo(src)
  const encryption = encryptionInfo.encryption
  const sendMode = encryptionInfo.encrypted ? ["-w"] : ["-p"]

  if (encryptionInfo.encrypted) {
    console.log(`Encryption detected: ${encryption}`)
    if (snapshots.length > 0) {
      console.log("Using raw encrypted send: zfs send -w")
    } else {
      console.log("Using encrypted destination creation plus rsync fallback")
    }
  } else {
    console.log("Dataset is not encrypted")
    console.log("Using property-preserving send: zfs send -p")
  }

  console.log()
  console.log(`Source:      ${src}`)
  console.log(`Target:      ${dst}`)
  console.log(`Snapshots:   ${snapshots.length}`)
  if (snapshots.length > 0) {
    console.log(`First snap:  ${snapshots[0]}`)
    console.log(`Latest snap: ${snapshots[snapshots.length - 1]}`)
  } else {
    console.log("Snapshotless: yes")
  }
  console.log()

  if (dryRun) {
    console.log("Dry run: no ZFS changes will be made.")
  }

  if (dryRun) {
    console.log(`Would ensure parent exists: ${dstParent}`)
  } else {
    console.log(`Ensuring parent exists: ${dstParent}`)
    try {
      runInherit("sudo", ["zfs", "create", "-p", dstParent])
    } catch {
      // Parent may already exist.
    }
  }

  if (snapshots.length === 0) {
    console.log("No direct snapshots found; using rsync fallback without creating snapshots.")

    validateOrRecreateSnapshotlessDestination(dst, encryptionInfo, destroyIfExists, dryRun)

    const srcMount = sourceMountpointForRsync(src)
    const dstMount = dryRun ? plannedMountpointForRsync(dst) : mountpointForRsync(dst)
    const childExcludes = childMountExcludes(src, srcMount)
    const userExcludes = normalizeRsyncExcludes(srcMount, rsyncExcludes)

    console.log(`Source mount: ${srcMount}`)
    console.log(`Target mount: ${dstMount}`)
    if (childExcludes.length > 0) {
      console.log(`Excluding child dataset mountpoints: ${childExcludes.join(", ")}`)
    }
    if (userExcludes.length > 0) {
      console.log(`Excluding requested rsync paths: ${userExcludes.join(", ")}`)
    }
    if (rsyncDeleteExcluded) {
      console.log("Rsync delete: enabled, including excluded paths")
    } else if (rsyncDelete) {
      console.log("Rsync delete: enabled")
    } else {
      console.log("Rsync delete: disabled")
    }
    runRsync(srcMount, dstMount, childExcludes, userExcludes, dryRun, rsyncDelete, rsyncDeleteExcluded)
    return
  }

  const first = snapshots[0]
  const latest = snapshots[snapshots.length - 1]
  const latestName = snapshotName(latest)

  let mode = "fresh"
  let sendArgs
  let baseSendArgs
  let incrSendArgs

  if (datasetExists(dst)) {
    const dstSnapshots = listDirectSnapshots(dst).map(snapshotName)
    const dstSnapshotSet = new Set(dstSnapshots)
    let commonSnapshot = ""
    let missingSnapshotCount = 0

    for (const snap of snapshots) {
      const name = snapshotName(snap)
      if (dstSnapshotSet.has(name)) {
        commonSnapshot = name
      } else {
        missingSnapshotCount += 1
      }
    }

    console.log()
    console.log("Destination already exists:")
    console.log(`  ${dst}`)
    if (commonSnapshot) {
      console.log(`Latest common snapshot: ${commonSnapshot}`)
      if (commonSnapshot === latestName && missingSnapshotCount > 0) {
        console.log(`Destination has the latest snapshot but is missing ${missingSnapshotCount} older snapshot(s).`)
        console.log("These cannot be backfilled incrementally.")
      } else {
        console.log("Type CONTINUE to send only newer snapshots.")
      }
    } else {
      console.log("No common snapshots found for resume.")
    }
    console.log("Type DESTROY to replace the destination from scratch.")
    console.log("Anything else aborts.")
    console.log()

    const choice = await promptChoice(destroyIfExists)
    if (choice === "CONTINUE") {
      if (!commonSnapshot) {
        throw new Error("Cannot continue because no common snapshot exists.")
      }
      if (commonSnapshot === latestName) {
        if (missingSnapshotCount > 0) {
          console.log(`Destination already has the latest snapshot, but is missing ${missingSnapshotCount} older snapshot(s).`)
          console.log("Use DESTROY to fully backfill snapshot history.")
        } else {
          console.log("Destination already has the latest snapshot. Nothing to do.")
        }
        return
      }
      mode = "resume"
      sendArgs = [...sendMode, "-I", `${src}@${commonSnapshot}`, latest]
    } else if (choice === "DESTROY") {
      if (dryRun) {
        console.log(`Would destroy destination: ${dst}`)
      } else {
        runInherit("sudo", ["zfs", "destroy", "-r", dst])
      }
    } else {
      throw new Error("Aborted.")
    }
  }

  if (mode === "fresh") {
    if (snapshots.length > 1) {
      baseSendArgs = [...sendMode, first]
      incrSendArgs = [...sendMode, "-I", first, latest]
    } else {
      baseSendArgs = [...sendMode, latest]
    }
  }

  console.log()
  console.log("Calculating stream size...")
  let size
  let baseSize
  let incrSize

  if (mode === "resume") {
    size = getSendSize(sendArgs)
  } else {
    baseSize = getSendSize(baseSendArgs)
    size = baseSize
    if (snapshots.length > 1) {
      incrSize = getSendSize(incrSendArgs)
      size = baseSize + incrSize
    }
  }

  console.log(`Estimated stream size: ${size} bytes`)
  console.log()

  if (dryRun) {
    if (mode === "resume") {
      console.log(`Would send incremental snapshot chain: ${sendArgs.join(" ")}`)
    } else if (snapshots.length > 1) {
      console.log(`Would send base snapshot: ${baseSendArgs.join(" ")}`)
      console.log(`Would send incremental snapshot chain: ${incrSendArgs.join(" ")}`)
    } else {
      console.log(`Would send snapshot: ${baseSendArgs.join(" ")}`)
    }
    return
  }

  if (mode === "resume") {
    console.log("Sending incremental snapshot chain...")
    await runPipeline(sendArgs, size, ["-u", "-F", dst])
  } else if (snapshots.length > 1) {
    console.log("Sending base snapshot...")
    await runPipeline(baseSendArgs, baseSize, ["-u", dst])
    console.log()
    console.log("Sending incremental snapshot chain...")
    await runPipeline(incrSendArgs, incrSize, ["-u", "-F", dst])
  } else {
    console.log("Sending snapshot...")
    await runPipeline(baseSendArgs, size, ["-u", "-F", dst])
  }

  console.log()
  console.log("Done:")
  runInherit("sudo", ["zfs", "list", "-r", dst])
}

module.exports = {
  main,
  parseArgs,
  normalizeDatasetInput,
  resolveDatasets,
  encryptionCreateOptions,
}

if (require.main === module) {
  main().catch((error) => {
    stderr.write(`${error.message}\n`)
    exit(1)
  })
}
