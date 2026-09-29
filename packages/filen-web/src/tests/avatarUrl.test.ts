import { describe, expect, it } from "vitest"
import { safeAvatarUrl } from "@/lib/avatarUrl"

describe("safeAvatarUrl", () => {
	it("returns the avatar only when it is a real https URL", () => {
		expect(safeAvatarUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png")
		expect(safeAvatarUrl("http://cdn.example/a.png")).toBeUndefined()
		expect(safeAvatarUrl("none")).toBeUndefined()
		expect(safeAvatarUrl(undefined)).toBeUndefined()
	})
})
