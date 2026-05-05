#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");
const { stdin, stdout, stderr, exit } = require("node:process");

function usage() {
  console.log("Usage: migrate-zfs-vol.js [--dry-run] [--destroy-if-exists] <src-dataset|legacy-name> [dst-dataset]");
  console.log("Example: migrate-zfs-vol.js tank/apps/api");
  console.log("Example: migrate-zfs-vol.js tank/apps/api jbod/apps/api");
  console.log("Example: migrate-zfs-vol.js --destroy-if-exists peakflow-production");
}

function resolveDatasets(srcInput, dstInput) {
  const src = srcInput.startsWith("tank/") ? srcInput : `tank/backups/${srcInput}`;
  if (!src.startsWith("tank/")) {
    throw new Error(`Source dataset must be in tank/: ${src}`);
  }

  const dst = dstInput || `jbod/${src.slice("tank/".length)}`;
  return { src, dst };
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const err = (result.stderr || "").trim() || `${command} exited with status ${result.status}`;
    throw new Error(err);
  }
  return result.stdout.trimEnd();
}

function runInherit(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function datasetExists(dataset) {
  const result = spawnSync("zfs", ["list", "-H", dataset], { stdio: "ignore" });
  return result.status === 0;
}

function zfsGet(dataset, property) {
  return runCapture("zfs", ["get", "-H", "-o", "value", property, dataset]).trim();
}

function listDirectSnapshots(dataset) {
  const output = runCapture("zfs", ["list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation", "-r", dataset]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith(`${dataset}@`));
}

function snapshotName(fullName) {
  return fullName.slice(fullName.indexOf("@") + 1);
}

function getSendSize(args) {
  const output = runCapture("sudo", ["zfs", "send", "-nP", ...args]);
  const sizeLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("size"));

  if (!sizeLine) {
    throw new Error("Could not calculate stream size");
  }

  const [, size] = sizeLine.split(/\s+/);
  return Number(size);
}

function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal) {
        reject(new Error(`${label} terminated by signal ${signal}`));
        return;
      }
      reject(new Error(`${label} exited with status ${code}`));
    });
  });
}

async function runPipeline(sendArgs, pvSize, recvArgs) {
  const sender = spawn("sudo", ["zfs", "send", ...sendArgs], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const progress = spawn("pv", ["-f", "-s", String(pvSize)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const receiver = spawn("sudo", ["zfs", "receive", ...recvArgs], {
    stdio: ["pipe", "inherit", "inherit"],
  });

  sender.stdout.pipe(progress.stdin);
  progress.stdout.pipe(receiver.stdin);

  await Promise.all([
    waitForChild(sender, "zfs send"),
    waitForChild(progress, "pv"),
    waitForChild(receiver, "zfs receive"),
  ]);
}

async function promptChoice(destroyIfExists) {
  if (destroyIfExists) {
    console.log("Choice: DESTROY (set by --destroy-if-exists)");
    return "DESTROY";
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question("Choice: ")).trim();
  } finally {
    rl.close();
  }
}

function mountpointForRsync(dataset) {
  const type = zfsGet(dataset, "type");
  if (type !== "filesystem") {
    throw new Error(`Cannot use rsync fallback for ${dataset}: ZFS type is ${type}, not filesystem`);
  }

  const mountpoint = zfsGet(dataset, "mountpoint");
  if (!mountpoint || mountpoint === "none" || mountpoint === "legacy") {
    throw new Error(`Cannot use rsync fallback for ${dataset}: mountpoint is ${mountpoint}`);
  }

  return mountpoint;
}

function rsyncArgs(srcMount, dstMount, dryRun) {
  const args = [
    "-aHAXx",
    "--numeric-ids",
    "--delete",
    "--info=progress2",
  ];

  if (dryRun) {
    args.push("--dry-run", "--itemize-changes");
  }

  args.push(`${srcMount}/`, `${dstMount}/`);
  return args;
}

function runRsync(srcMount, dstMount, dryRun) {
  const args = rsyncArgs(srcMount, dstMount, dryRun);
  if (dryRun) {
    console.log(`Would run rsync: rsync ${args.join(" ")}`);
    return;
  }

  runInherit("sudo", ["rsync", ...args]);
}

async function main() {
  const args = process.argv.slice(2);
  let destroyIfExists = false;
  let dryRun = false;

  while (args[0] === "--destroy-if-exists" || args[0] === "--dry-run") {
    if (args[0] === "--destroy-if-exists") {
      destroyIfExists = true;
    }
    if (args[0] === "--dry-run") {
      dryRun = true;
    }
    args.shift();
  }

  if (args.length < 1 || args.length > 2) {
    usage();
    exit(1);
  }

  const { src, dst } = resolveDatasets(args[0], args[1]);
  const dstParent = dst.includes("/") ? dst.slice(0, dst.lastIndexOf("/")) : dst;

  if (!datasetExists(src)) {
    throw new Error(`Source dataset does not exist: ${src}`);
  }

  const snapshots = listDirectSnapshots(src);
  const encryption = zfsGet(src, "encryption");
  const sendMode = encryption !== "off" ? ["-w"] : ["-p"];

  if (encryption !== "off") {
    console.log(`Encryption detected: ${encryption}`);
    console.log("Using raw encrypted send: zfs send -w");
  } else {
    console.log("Dataset is not encrypted");
    console.log("Using property-preserving send: zfs send -p");
  }

  console.log();
  console.log(`Source:      ${src}`);
  console.log(`Target:      ${dst}`);
  console.log(`Snapshots:   ${snapshots.length}`);
  if (snapshots.length > 0) {
    console.log(`First snap:  ${snapshots[0]}`);
    console.log(`Latest snap: ${snapshots[snapshots.length - 1]}`);
  } else {
    console.log("Snapshotless: yes");
  }
  console.log();

  if (dryRun) {
    console.log("Dry run: no ZFS changes will be made.");
  }

  if (dryRun) {
    console.log(`Would ensure parent exists: ${dstParent}`);
  } else {
    console.log(`Ensuring parent exists: ${dstParent}`);
    try {
      runInherit("sudo", ["zfs", "create", "-p", dstParent]);
    } catch {
      // Parent may already exist.
    }
  }

  if (snapshots.length === 0) {
    console.log("No direct snapshots found; using rsync fallback without creating snapshots.");

    if (!datasetExists(dst)) {
      if (dryRun) {
        console.log(`Would create destination filesystem: ${dst}`);
      } else {
        runInherit("sudo", ["zfs", "create", "-p", dst]);
      }
    }

    const srcMount = mountpointForRsync(src);
    const dstMount = mountpointForRsync(dst);

    console.log(`Source mount: ${srcMount}`);
    console.log(`Target mount: ${dstMount}`);
    runRsync(srcMount, dstMount, dryRun);
    return;
  }

  const first = snapshots[0];
  const latest = snapshots[snapshots.length - 1];
  const latestName = snapshotName(latest);

  let mode = "fresh";
  let sendArgs;
  let baseSendArgs;
  let incrSendArgs;

  if (datasetExists(dst)) {
    const dstSnapshots = listDirectSnapshots(dst).map(snapshotName);
    const dstSnapshotSet = new Set(dstSnapshots);
    let commonSnapshot = "";
    let missingSnapshotCount = 0;

    for (const snap of snapshots) {
      const name = snapshotName(snap);
      if (dstSnapshotSet.has(name)) {
        commonSnapshot = name;
      } else {
        missingSnapshotCount += 1;
      }
    }

    console.log();
    console.log("Destination already exists:");
    console.log(`  ${dst}`);
    if (commonSnapshot) {
      console.log(`Latest common snapshot: ${commonSnapshot}`);
      if (commonSnapshot === latestName && missingSnapshotCount > 0) {
        console.log(`Destination has the latest snapshot but is missing ${missingSnapshotCount} older snapshot(s).`);
        console.log("These cannot be backfilled incrementally.");
      } else {
        console.log("Type CONTINUE to send only newer snapshots.");
      }
    } else {
      console.log("No common snapshots found for resume.");
    }
    console.log("Type DESTROY to replace the destination from scratch.");
    console.log("Anything else aborts.");
    console.log();

    const choice = await promptChoice(destroyIfExists);
    if (choice === "CONTINUE") {
      if (!commonSnapshot) {
        throw new Error("Cannot continue because no common snapshot exists.");
      }
      if (commonSnapshot === latestName) {
        if (missingSnapshotCount > 0) {
          console.log(`Destination already has the latest snapshot, but is missing ${missingSnapshotCount} older snapshot(s).`);
          console.log("Use DESTROY to fully backfill snapshot history.");
        } else {
          console.log("Destination already has the latest snapshot. Nothing to do.");
        }
        return;
      }
      mode = "resume";
      sendArgs = [...sendMode, "-I", `${src}@${commonSnapshot}`, latest];
    } else if (choice === "DESTROY") {
      if (dryRun) {
        console.log(`Would destroy destination: ${dst}`);
      } else {
        runInherit("sudo", ["zfs", "destroy", "-r", dst]);
      }
    } else {
      throw new Error("Aborted.");
    }
  }

  if (mode === "fresh") {
    if (snapshots.length > 1) {
      baseSendArgs = [...sendMode, first];
      incrSendArgs = [...sendMode, "-I", first, latest];
    } else {
      baseSendArgs = [...sendMode, latest];
    }
  }

  console.log();
  console.log("Calculating stream size...");
  let size;
  let baseSize;
  let incrSize;

  if (mode === "resume") {
    size = getSendSize(sendArgs);
  } else {
    baseSize = getSendSize(baseSendArgs);
    size = baseSize;
    if (snapshots.length > 1) {
      incrSize = getSendSize(incrSendArgs);
      size = baseSize + incrSize;
    }
  }

  console.log(`Estimated stream size: ${size} bytes`);
  console.log();

  if (dryRun) {
    if (mode === "resume") {
      console.log(`Would send incremental snapshot chain: ${sendArgs.join(" ")}`);
    } else if (snapshots.length > 1) {
      console.log(`Would send base snapshot: ${baseSendArgs.join(" ")}`);
      console.log(`Would send incremental snapshot chain: ${incrSendArgs.join(" ")}`);
    } else {
      console.log(`Would send snapshot: ${baseSendArgs.join(" ")}`);
    }
    return;
  }

  if (mode === "resume") {
    console.log("Sending incremental snapshot chain...");
    await runPipeline(sendArgs, size, ["-u", "-F", dst]);
  } else if (snapshots.length > 1) {
    console.log("Sending base snapshot...");
    await runPipeline(baseSendArgs, baseSize, ["-u", dst]);
    console.log();
    console.log("Sending incremental snapshot chain...");
    await runPipeline(incrSendArgs, incrSize, ["-u", "-F", dst]);
  } else {
    console.log("Sending snapshot...");
    await runPipeline(baseSendArgs, size, ["-u", "-F", dst]);
  }

  console.log();
  console.log("Done:");
  runInherit("sudo", ["zfs", "list", "-r", dst]);
}

main().catch((error) => {
  stderr.write(`${error.message}\n`);
  exit(1);
});
