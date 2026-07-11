import { describe, expect, it } from "vitest"
import type { GdprInfo } from "@filen/sdk-rs"
import { gdprInfoToJson } from "@/features/settings/lib/gdprExport"

function sampleInfo(): GdprInfo {
	return {
		user: {
			email: "user@example.com",
			lastActive: 1700000000000n,
			lastActiveChat: 1700000001000n,
			lastIpAddress: "1.2.3.4",
			nickName: undefined,
			firstName: "Jane",
			lastName: undefined,
			companyName: undefined,
			vatId: undefined,
			street: undefined,
			streetNumber: undefined,
			city: undefined,
			postalCode: undefined,
			country: undefined
		},
		events: { ipAddresses: ["1.2.3.4"], userAgents: ["test-agent"] }
	}
}

describe("gdprInfoToJson", () => {
	it("serializes bigint fields as plain decimal strings rather than throwing", () => {
		const json = gdprInfoToJson(sampleInfo())
		const parsed: unknown = JSON.parse(json)

		expect(parsed).toMatchObject({
			user: { email: "user@example.com", lastActive: "1700000000000", lastActiveChat: "1700000001000" }
		})
	})

	it('is valid, pretty-printed JSON (never the app\'s internal "$bigint:" persistence envelope)', () => {
		const json = gdprInfoToJson(sampleInfo())

		expect(json).toContain("\n")
		expect(json).not.toContain("$bigint:")
		expect(() => JSON.parse(json) as unknown).not.toThrow()
	})

	it("round-trips non-bigint fields verbatim", () => {
		const info = sampleInfo()
		const parsed = JSON.parse(gdprInfoToJson(info)) as { events: GdprInfo["events"] }

		expect(parsed.events).toEqual(info.events)
	})
})
