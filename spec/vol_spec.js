const {
  encryptionCreateOptions,
  normalizeDatasetInput,
  parseArgs,
  resolveDatasets,
} = require("../src/vol")

describe("vol command argument handling", () => {
  it("parses rsync and mode options", () => {
    expect(parseArgs([
      "--dry-run",
      "--destroy-if-exists",
      "--rsync-exclude",
      "/tank/cache",
      "--rsync-delete-excluded",
      "/tank/apps/api",
      "/jbod/apps/api",
    ])).toEqual({
      destroyIfExists: true,
      dryRun: true,
      rsyncExcludes: ["/tank/cache"],
      rsyncDelete: true,
      rsyncDeleteExcluded: true,
      positionals: ["/tank/apps/api", "/jbod/apps/api"],
    })
  })

  it("normalizes leading and trailing slashes in dataset arguments", () => {
    expect(normalizeDatasetInput("/tank/apps/api/")).toBe("tank/apps/api")
  })

  it("keeps the legacy backup shorthand", () => {
    expect(resolveDatasets("demo-production")).toEqual({
      src: "tank/backups/demo-production",
      dst: "jbod/backups/demo-production",
    })
  })

  it("supports explicit reverse migrations", () => {
    expect(resolveDatasets("/jbod/apps/api", "/tank/apps/api")).toEqual({
      src: "jbod/apps/api",
      dst: "tank/apps/api",
    })
  })

  it("requires an explicit destination for non-tank sources", () => {
    expect(() => resolveDatasets("/jbod/apps/api")).toThrowError(/Destination dataset is required/)
  })

  it("builds prompt-based encryption create options by default", () => {
    expect(encryptionCreateOptions({
      encrypted: true,
      encryption: "aes-256-gcm",
      keyformat: "passphrase",
      keylocation: "prompt",
    })).toEqual([
      "-o", "encryption=aes-256-gcm",
      "-o", "keyformat=passphrase",
      "-o", "keylocation=prompt",
    ])
  })

  it("reuses non-prompt key locations", () => {
    expect(encryptionCreateOptions({
      encrypted: true,
      encryption: "aes-256-gcm",
      keyformat: "raw",
      keylocation: "file:///root/zfs.key",
    })).toEqual([
      "-o", "encryption=aes-256-gcm",
      "-o", "keyformat=raw",
      "-o", "keylocation=file:///root/zfs.key",
    ])
  })
})
