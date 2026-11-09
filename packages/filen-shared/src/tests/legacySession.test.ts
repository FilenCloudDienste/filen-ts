import { describe, expect, it } from "vitest"
import { convertLegacySession } from "@filen/shared/legacySession"

// Fixtures only: shaped like the old client's values, with made-up content.
const SDK_CONFIG = {
	email: "user@example.com",
	password: "redacted",
	twoFactorCode: "redacted",
	masterKeys: ["first-master-key", "second-master-key"],
	apiKey: "a".repeat(64),
	publicKey: "public-key",
	privateKey: "private-key",
	authVersion: 2,
	baseFolderUUID: "00000000-0000-4000-8000-000000000001",
	userId: 123456,
	metadataCache: true,
	tmpPath: "",
	connectToSocket: true
}

function convert(change: Record<string, unknown> = {}, authed: string | null = "true") {
	return convertLegacySession(authed, JSON.stringify({ ...SDK_CONFIG, ...change }))
}

describe("convertLegacySession", () => {
	it("converts the old account into the SDK's stringified client", () => {
		expect(convert()).toEqual({
			ok: true,
			userId: 123456,
			session: {
				email: "user@example.com",
				rootUuid: "00000000-0000-4000-8000-000000000001",
				authInfo: "first-master-key|second-master-key",
				privateKey: "private-key",
				apiKey: "a".repeat(64),
				userId: 123456n,
				authVersion: 2
			}
		})
	})

	it("needs the old client's signed-in flag", () => {
		expect(convert({}, "false")).toEqual({ ok: false, reason: "not-signed-in" })
		expect(convert({}, null)).toEqual({ ok: false, reason: "not-signed-in" })
		expect(convertLegacySession(undefined, undefined)).toEqual({ ok: false, reason: "not-signed-in" })
	})

	it.each([
		["the anonymous config", { apiKey: "anonymous" }],
		["a short api key", { apiKey: "short" }],
		["the signed-out user id", { userId: 1 }],
		["a fractional user id", { userId: 2.5 }],
		["an unsafe user id", { userId: 2 ** 60 }],
		["an unknown auth version", { authVersion: 4 }],
		["no master keys", { masterKeys: [] }],
		["a master key with the separator", { masterKeys: ["a|b"] }],
		["a value the envelope would have to escape", { email: "$bigint:1n" }],
		["a missing field", { privateKey: undefined }]
	])("refuses %s", (_label, change) => {
		expect(convert(change)).toEqual({ ok: false, reason: "invalid-account" })
	})

	it("refuses an unparsable or missing config", () => {
		expect(convertLegacySession("true", "{")).toEqual({ ok: false, reason: "invalid-account" })
		expect(convertLegacySession("true", null)).toEqual({ ok: false, reason: "invalid-account" })
	})
})
