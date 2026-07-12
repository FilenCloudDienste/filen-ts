import { describe, it, expect } from "vitest"
import { nextOfflineStatus, toIndicatorStatus } from "@/features/shell/lib/offlineIndicator.logic"

describe("nextOfflineStatus", () => {
	it("goes offline from online on a drop", () => {
		expect(nextOfflineStatus("online", false)).toBe("offline")
	})

	it("goes offline from back-online on a drop", () => {
		expect(nextOfflineStatus("back-online", false)).toBe("offline")
	})

	it("promotes offline to back-online on a return", () => {
		expect(nextOfflineStatus("offline", true)).toBe("back-online")
	})

	it("keeps online as online on a redundant return", () => {
		expect(nextOfflineStatus("online", true)).toBe("online")
	})

	it("keeps back-online as back-online on a redundant return", () => {
		expect(nextOfflineStatus("back-online", true)).toBe("back-online")
	})
})

describe("toIndicatorStatus", () => {
	it("maps online to hidden", () => {
		expect(toIndicatorStatus("online")).toBe("hidden")
	})

	it("passes offline through unchanged", () => {
		expect(toIndicatorStatus("offline")).toBe("offline")
	})

	it("passes back-online through unchanged", () => {
		expect(toIndicatorStatus("back-online")).toBe("back-online")
	})
})
