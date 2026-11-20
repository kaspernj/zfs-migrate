// Path-filter validation delivery.

const {
  datasetToDest,
  normalizeDatasetRoot,
  parseArgs,
} = require("../src/all")

describe("all command argument handling", () => {
  it("parses options and source/destination roots", () => {
    expect(parseArgs([
      "--dry-run",
      "--interactive",
      "--rsync-exclude=/tank/cache",
      "--rsync-delete",
      "/tank",
      "/jbod",
    ])).toEqual({
      dryRun: true,
      interactive: true,
      rsyncExcludes: ["/tank/cache"],
      rsyncDelete: true,
      rsyncDeleteExcluded: false,
      positionals: ["/tank", "/jbod"],
    })
  })

  it("normalizes root arguments into ZFS dataset names", () => {
    expect(normalizeDatasetRoot("/tank/")).toBe("tank")
  })

  it("maps child datasets from source root to destination root", () => {
    expect(datasetToDest("tank/apps/api", "tank", "jbod")).toBe("jbod/apps/api")
  })

  it("maps the root dataset itself", () => {
    expect(datasetToDest("tank", "tank", "jbod")).toBe("jbod")
  })

  it("rejects datasets outside the source root", () => {
    expect(() => datasetToDest("other/apps/api", "tank", "jbod")).toThrowError(/Source dataset must be in tank/)
  })
})
