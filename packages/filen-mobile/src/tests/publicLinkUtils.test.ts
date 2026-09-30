import { vi, describe, it, expect } from "vitest"
import {
	currentHeldLinkStatus,
	HELD_LINK_STATUS_TRUST_MS,
	isPublicLinkQueryError,
	linkStatusForWrite,
	recentHeldLinkStatus
} from "@/features/publicLink/utils"

describe("isPublicLinkQueryError", () => {
	it("returns true when publicLinkStatus is error", () => {
		expect(isPublicLinkQueryError("error", "success")).toBe(true)
	})

	it("returns true when account is error", () => {
		expect(isPublicLinkQueryError("success", "error")).toBe(true)
	})

	it("returns true when both are error", () => {
		expect(isPublicLinkQueryError("error", "error")).toBe(true)
	})

	it("returns false when both are pending", () => {
		expect(isPublicLinkQueryError("pending", "pending")).toBe(false)
	})

	it("returns false when both are success", () => {
		expect(isPublicLinkQueryError("success", "success")).toBe(false)
	})

	it("returns false when one is success and the other is pending", () => {
		expect(isPublicLinkQueryError("success", "pending")).toBe(false)
		expect(isPublicLinkQueryError("pending", "success")).toBe(false)
	})
})

describe("the link status the screen holds", () => {
	const persisted = { linkUuid: "old" }
	const fresh = { linkUuid: "new" }

	function query(
		fetchStatus: "fetching" | "paused" | "idle",
		data: typeof persisted | null,
		status: "pending" | "error" | "success" = "success",
		dataUpdatedAt: number = Date.now()
	) {
		return {
			status,
			fetchStatus,
			data,
			dataUpdatedAt,
			refetch: vi.fn(async () => ({ data: fresh }))
		}
	}

	it("is current only once the mount read has settled", () => {
		expect(currentHeldLinkStatus(query("idle", null))).toEqual({ current: true, value: null })
		expect(currentHeldLinkStatus(query("idle", persisted))).toEqual({ current: true, value: persisted })
		// A persisted "no link" or link shown while the read is in flight is not trusted.
		expect(currentHeldLinkStatus(query("fetching", null))).toEqual({ current: false })
		expect(currentHeldLinkStatus(query("fetching", persisted))).toEqual({ current: false })
		expect(currentHeldLinkStatus(query("paused", persisted))).toEqual({ current: false })
		expect(currentHeldLinkStatus(query("idle", persisted, "error"))).toEqual({ current: false })
	})

	it("a save builds on the held status when current, else joins the read in flight", async () => {
		const settled = query("idle", persisted)

		expect(await linkStatusForWrite(settled)).toBe(persisted)
		expect(settled.refetch).not.toHaveBeenCalled()

		const reading = query("fetching", persisted)

		expect(await linkStatusForWrite(reading)).toBe(fresh)
		expect(reading.refetch).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false })
	})

	it("enable and disable act on it only while it is recent: an older read may be a link changed elsewhere since", () => {
		const recent = Date.now() - 1000
		const old = Date.now() - HELD_LINK_STATUS_TRUST_MS - 1000

		expect(recentHeldLinkStatus(query("idle", persisted, "success", recent))).toEqual({ current: true, value: persisted })
		expect(recentHeldLinkStatus(query("idle", null, "success", recent))).toEqual({ current: true, value: null })
		expect(recentHeldLinkStatus(query("idle", persisted, "success", old))).toEqual({ current: false })
		expect(recentHeldLinkStatus(query("idle", null, "success", old))).toEqual({ current: false })
		// Recent but not settled is still not trusted.
		expect(recentHeldLinkStatus(query("fetching", persisted, "success", recent))).toEqual({ current: false })
	})

	it("a save still builds on an older settled read (its own write re-checks the link)", async () => {
		const old = query("idle", persisted, "success", Date.now() - HELD_LINK_STATUS_TRUST_MS - 1000)

		expect(await linkStatusForWrite(old)).toBe(persisted)
		expect(old.refetch).not.toHaveBeenCalled()
	})
})
