import { describe, expect, it } from "vitest"
import { isPermissionAllowed } from "../main/permissions.ts"

const APP = "filen://app"

describe("isPermissionAllowed", () => {
	it("allows what the web app uses, from the app", () => {
		expect(isPermissionAllowed("clipboard-sanitized-write", "filen://app/drive", APP)).toBe(true)
		expect(isPermissionAllowed("fileSystem", "filen://app/", APP)).toBe(true)
	})

	it.each(["media", "display-capture", "geolocation", "midi", "openExternal", "notifications"])("denies %s", permission => {
		expect(isPermissionAllowed(permission, "filen://app/", APP)).toBe(false)
	})

	it("denies any other origin", () => {
		expect(isPermissionAllowed("fullscreen", "https://example.com/", APP)).toBe(false)
	})
})
