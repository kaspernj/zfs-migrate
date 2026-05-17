#!/usr/bin/env node

const { stderr, exit } = require("node:process")
const { main: allMain } = require("../src/all")
const { main: volMain } = require("../src/vol")

function usage() {
  console.log("Usage: zfs-migrate <command> [options]")
  console.log()
  console.log("Commands:")
  console.log("  vol <src-dataset> <dst-dataset>     Migrate one dataset")
  console.log("  all [src-root dst-root]             Migrate all child datasets under a root")
  console.log()
  console.log("Examples:")
  console.log("  zfs-migrate vol /tank/myvol /jbod/myvol")
  console.log("  zfs-migrate all /tank /jbod")
  console.log("  zfs-migrate all --dry-run /tank /jbod")
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv

  if (!command || command === "--help" || command === "-h") {
    usage()
    return
  }

  if (command === "vol" || command === "volume" || command === "dataset") {
    await volMain(args, { commandName: "zfs-migrate vol" })
    return
  }

  if (command === "all") {
    await allMain(args, { commandName: "zfs-migrate all" })
    return
  }

  usage()
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  stderr.write(`${error.message}\n`)
  exit(1)
})
