import { describe, expect, it } from "vitest"
import { legacyPageResponse } from "../main/legacyOrigin.ts"

describe("legacyPageResponse", () => {
	it("serves an empty page that may load nothing at the root of the old origin", async () => {
		const response = legacyPageResponse("filendesktop://bundle/")

		expect(response.status).toBe(200)
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'")
		expect(await response.text()).not.toContain("<script")
	})

	it("serves nothing else", () => {
		expect(legacyPageResponse("filendesktop://bundle/index.html").status).toBe(404)
		expect(legacyPageResponse("filendesktop://bundle/assets/app.js").status).toBe(404)
		expect(legacyPageResponse("filendesktop://other/").status).toBe(404)
	})
})
