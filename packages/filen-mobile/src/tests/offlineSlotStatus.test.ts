import { describe, it, expect } from "vitest"
import { nextOfflineStatus, resolveConnectionSlotStatus, type OfflineStatus } from "@/components/floatingBar/offlineSlotStatus"

describe("offlineSlotStatus — nextOfflineStatus", () => {
	it("goes offline whenever connectivity drops, from any prior status", () => {
		const priors: OfflineStatus[] = ["online", "offline", "back-online"]

		for (const prev of priors) {
			expect(nextOfflineStatus(prev, false)).toBe("offline")
		}
	})

	it("flips offline → back-online when connectivity returns", () => {
		expect(nextOfflineStatus("offline", true)).toBe("back-online")
	})

	it("keeps the prior status when already online and connectivity stays up", () => {
		expect(nextOfflineStatus("online", true)).toBe("online")
		expect(nextOfflineStatus("back-online", true)).toBe("back-online")
	})
})

describe("offlineSlotStatus — resolveConnectionSlotStatus", () => {
	it("shows offline over a certificate failure (no request leaves the device)", () => {
		expect(resolveConnectionSlotStatus("offline", true)).toBe("offline")
	})

	it("shows unverified while online with a certificate failure, replacing the back-online confirmation", () => {
		expect(resolveConnectionSlotStatus("online", true)).toBe("unverified")
		expect(resolveConnectionSlotStatus("back-online", true)).toBe("unverified")
	})

	it("passes the connectivity status through without a certificate failure", () => {
		const statuses: OfflineStatus[] = ["online", "offline", "back-online"]

		for (const status of statuses) {
			expect(resolveConnectionSlotStatus(status, false)).toBe(status)
		}
	})
})
