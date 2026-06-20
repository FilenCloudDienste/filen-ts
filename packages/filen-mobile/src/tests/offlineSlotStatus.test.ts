import { describe, it, expect } from "vitest"
import { nextOfflineStatus, type OfflineStatus } from "@/components/floatingBar/offlineSlotStatus"

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
