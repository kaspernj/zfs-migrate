#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

function canWriteDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    }
    fs.accessSync(path.dirname(dir), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const LOGS_ROOT = canWriteDir("logs") ? "logs" : "logs-local";
const STATE_ROOT = canWriteDir("state") ? "state" : "state-local";
const RUN_TS = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const LOGS_DIR = path.join(LOGS_ROOT, RUN_TS);
const FAILURES_FILE = path.join(LOGS_DIR, "failed-migrations.txt");
const SKIPPED_COMPLETED_FILE = path.join(LOGS_DIR, "skipped-completed.txt");
const STATE_DIR = STATE_ROOT;
const COMPLETED_FILE = path.join(STATE_DIR, "completed-migrations.tsv");
const RSYNC_MARKER = "(rsync)";

function usage() {
  console.log("Usage: migrate-all.js [--dry-run] [--interactive]");
}

function printSkipCompleted(src, marker, dryRun) {
  if (dryRun) {
    console.log(`DRY RUN: would skip ${src}@${marker} because destination already fully matches source`);
  } else {
    console.log(`SKIP completed: ${src}@${marker}`);
  }
}

function printMigrate(src, dst, dryRun, reason) {
  if (dryRun) {
    console.log(`DRY RUN: would migrate ${src} -> ${dst} because ${reason}`);
  } else {
    console.log(`=== MIGRATING ${src} -> ${dst} ===`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const err = (result.stderr || "").trim() || `${command} exited with status ${result.status}`;
    throw new Error(err);
  }
  return result.stdout.trimEnd();
}

function zfsGet(dataset, property) {
  return runCapture("zfs", ["get", "-H", "-o", "value", property, dataset]).trim();
}

function datasetToDest(src) {
  if (!src.startsWith("tank/")) {
    throw new Error(`Source dataset must be in tank/: ${src}`);
  }
  return `jbod/${src.slice("tank/".length)}`;
}

function snapshotNames(dataset) {
  const output = runCapture("zfs", ["list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation", "-r", dataset]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith(`${dataset}@`))
    .map((line) => line.slice(line.indexOf("@") + 1));
}

function latestSnapshotName(dataset) {
  const names = snapshotNames(dataset);
  return names.length === 0 ? null : names[names.length - 1];
}

function datasetExists(dataset) {
  const result = spawnSync("zfs", ["list", "-H", dataset], { stdio: "ignore" });
  return result.status === 0;
}

function mountpointForRsync(dataset) {
  const type = zfsGet(dataset, "type");
  if (type !== "filesystem") {
    throw new Error(`Cannot use rsync verification for ${dataset}: ZFS type is ${type}, not filesystem`);
  }

  const mountpoint = zfsGet(dataset, "mountpoint");
  if (!mountpoint || mountpoint === "none" || mountpoint === "legacy") {
    throw new Error(`Cannot use rsync verification for ${dataset}: mountpoint is ${mountpoint}`);
  }

  return mountpoint;
}

function verifyRsyncSync(src, dst) {
  if (!datasetExists(dst)) {
    return false;
  }

  const srcMount = mountpointForRsync(src);
  const dstMount = mountpointForRsync(dst);
  const result = spawnSync(
    "rsync",
    ["-aHAXxn", "--numeric-ids", "--delete", "--itemize-changes", `${srcMount}/`, `${dstMount}/`],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    const err = (result.stderr || "").trim() || `rsync exited with status ${result.status}`;
    throw new Error(err);
  }

  return result.stdout.trim() === "";
}

function verifyMigration(src, dst) {
  const latestSnapshot = latestSnapshotName(src);
  if (latestSnapshot) {
    if (!datasetExists(dst)) {
      return { ok: false, marker: latestSnapshot, mode: "snapshot" };
    }

    const srcSnapshots = snapshotNames(src);
    const dstSnapshots = snapshotNames(dst);
    const ok = srcSnapshots.length === dstSnapshots.length && srcSnapshots.every((snap, idx) => snap === dstSnapshots[idx]);
    return { ok, marker: latestSnapshot, mode: "snapshot" };
  }

  const ok = verifyRsyncSync(src, dst);
  return { ok, marker: RSYNC_MARKER, mode: "rsync" };
}

function sanitizeDatasetName(dataset) {
  return dataset.replaceAll("/", "__");
}

function appendLine(file, line) {
  fs.appendFileSync(file, `${line}\n`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadCompletedRecords() {
  if (!fs.existsSync(COMPLETED_FILE)) {
    return [];
  }
  return fs
    .readFileSync(COMPLETED_FILE, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return {
        src: parts[0],
        dst: parts[1] || "",
        marker: parts[2] || "",
        runTs: parts[3] || "",
        logFile: parts[4] || "",
      };
    });
}

function saveCompletedRecords(records) {
  const body = records
    .map((record) => [record.src, record.dst, record.marker, record.runTs, record.logFile].join("\t"))
    .join("\n");
  fs.writeFileSync(COMPLETED_FILE, body ? `${body}\n` : "");
}

function hasCompletedRecord(records, src, dst, marker) {
  return records.some((record) => record.src === src && record.dst === dst && record.marker === marker);
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
  ];
}

function runMigration(src, dst, logFile, dryRun, interactive) {
  if (dryRun) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const childArgs = ["./migrate-zfs-vol.js"];
    if (!interactive) {
      childArgs.push("--destroy-if-exists");
    }
    childArgs.push(src, dst);

    const child = spawn("sudo", childArgs, {
      stdio: ["inherit", "pipe", "pipe"],
    });
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });

    child.on("error", (error) => {
      const msg = `${error.message}\n`;
      process.stderr.write(msg);
      logStream.write(msg);
      logStream.end(() => resolve(false));
    });

    child.on("exit", (code) => {
      logStream.end(() => resolve(code === 0));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const interactive = args.includes("--interactive");

  if (args.some((arg) => arg !== "--dry-run" && arg !== "--interactive")) {
    usage();
    process.exit(1);
  }

  if (!dryRun) {
    ensureDir(LOGS_DIR);
    ensureDir(STATE_DIR);
    if (!fs.existsSync(COMPLETED_FILE)) {
      fs.writeFileSync(COMPLETED_FILE, "");
    }
  }

  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`);
  console.log(`Prompting: ${interactive ? "interactive" : "auto-destroy"}`);
  console.log(`Logs: ${LOGS_DIR}`);
  console.log(`State: ${STATE_DIR}`);

  const datasets = runCapture("zfs", ["list", "-H", "-o", "name", "-r", "tank"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((dataset) => dataset !== "tank")
    .sort();

  let completedRecords = loadCompletedRecords();

  for (const src of datasets) {
    const dst = datasetToDest(src);
    const logFile = path.join(LOGS_DIR, `${sanitizeDatasetName(src)}.log`);
    const preflight = verifyMigration(src, dst);

    if (preflight.ok) {
      printSkipCompleted(src, preflight.marker, dryRun);
      if (!dryRun) {
        appendLine(SKIPPED_COMPLETED_FILE, `${src}\t${dst}\t${preflight.marker}`);
        if (!hasCompletedRecord(completedRecords, src, dst, preflight.marker)) {
          completedRecords = upsertCompletedRecord(completedRecords, src, dst, preflight.marker, logFile);
          saveCompletedRecords(completedRecords);
        }
      }
      continue;
    }

    const reason = preflight.mode === "snapshot"
      ? "destination is missing snapshots or does not fully match source"
      : "dataset has no snapshots, so rsync fallback is required";
    printMigrate(src, dst, dryRun, reason);

    const ok = await runMigration(src, dst, logFile, dryRun, interactive);
    if (!ok) {
      console.log(`FAILED: ${src}`);
      if (!dryRun) {
        appendLine(FAILURES_FILE, `${src}\t${dst}\t${logFile}`);
      }
      continue;
    }

    if (dryRun) {
      continue;
    }

    const postflight = verifyMigration(src, dst);
    if (!postflight.ok) {
      const msg = "Post-migration verification failed: destination does not fully match source.\n";
      process.stderr.write(msg);
      fs.appendFileSync(logFile, msg);
      console.log(`FAILED: ${src}`);
      appendLine(FAILURES_FILE, `${src}\t${dst}\t${logFile}`);
      continue;
    }

    console.log(`OK: ${src}`);
    completedRecords = upsertCompletedRecord(completedRecords, src, dst, postflight.marker, logFile);
    saveCompletedRecords(completedRecords);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
