import { describe, expect, it } from "vitest"
import { gateFor, UNGATED_MAX_BYTES } from "@/features/archive/lib/archiveGate.logic"

const BIG = 50 * 1024 * 1024 * 1024

describe("gateFor", () => {
	it("lists a zip or 7z at once, whatever its size (only the index is read)", () => {
		expect(gateFor({ type: "zip" }, BIG)).toBe("list")
		expect(gateFor({ type: "sevenZ" }, BIG)).toBe("list")
	})

	it("gates a tar, a single compressed file and an unknown format above 8 MiB", () => {
		expect(gateFor({ type: "tar", codec: "gzip" }, BIG)).toBe("gate")
		expect(gateFor({ type: "tar", codec: undefined }, UNGATED_MAX_BYTES + 1)).toBe("gate")
		expect(gateFor({ type: "single", codec: "zstd" }, UNGATED_MAX_BYTES + 1)).toBe("gate")
		expect(gateFor(null, UNGATED_MAX_BYTES + 1)).toBe("gate")
	})

	it("lists one of up to 8 MiB at once", () => {
		expect(UNGATED_MAX_BYTES).toBe(8 * 1024 * 1024)
		expect(gateFor({ type: "tar", codec: "xz" }, UNGATED_MAX_BYTES)).toBe("list")
		expect(gateFor({ type: "single", codec: "gzip" }, 0)).toBe("list")
		expect(gateFor(null, 1024)).toBe("list")
	})
})
