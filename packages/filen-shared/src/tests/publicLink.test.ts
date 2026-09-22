import { describe, it, expect } from "vitest"
import { parseFilenPublicLink } from "@filen/shared"

// Version 4 (third group starts "4"), variant 8 (fourth "8") — the 'uuid' package's validate() (which
// parseFilenPublicLink uses) enforces both nibbles, unlike a plain 8-4-4-4-12 hex-shape regex.
const UUID = "11111111-2222-4333-8444-555555555555"
// A UUID with hex letters, for the case-insensitivity tests below — UUID above is all-digit, so
// toUpperCase() on it would be a no-op.
const UUID_MIXED = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
// A realistic 32-byte key → 64 hex chars; @filen/shared's parseFilenPublicLink hard-rejects any other
// decoded length. No Node Buffer here — shared's own test tree stays free of Node-module imports, so
// the hex is derived from char codes instead.
const KEY_PLAINTEXT = "0123456789abcdef0123456789abcdef"
const KEY_HEX = [...KEY_PLAINTEXT].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")

describe("parseFilenPublicLink — new path format (letters swapped from legacy)", () => {
	it("recognizes /f/ as a FILE", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/f/${UUID}#${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})

	it("recognizes /d/ as a DIRECTORY", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/d/${UUID}#${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "directory"
		})
	})

	it("accepts a %23-encoded separator too", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/f/${UUID}%23${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})

	it("widens to an uppercase host, path letter and uuid (the i-flag this batch adds)", () => {
		const upper = UUID_MIXED.toUpperCase()

		expect(parseFilenPublicLink(`HTTPS://APP.FILEN.IO/F/${upper}#${KEY_HEX}`)).toEqual({
			uuid: upper,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})
})

describe("parseFilenPublicLink — legacy hash format (letters swapped: f=dir, d=file)", () => {
	it("recognizes legacy /d/ as a FILE", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}%23${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})

	it("recognizes legacy /f/ as a DIRECTORY", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/f/${UUID}%23${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "directory"
		})
	})

	it("accepts a legacy literal # separator", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}#${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})

	it("accepts the drive.filen.io legacy host", () => {
		expect(parseFilenPublicLink(`https://drive.filen.io/#/d/${UUID}%23${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})

	it("accepts a genuinely raw (non-hex) legacy key of exactly 32 bytes — mobile's old behavior", () => {
		const rawKey = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"

		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}%23${rawKey}`)).toEqual({
			uuid: UUID,
			key: rawKey,
			type: "file"
		})
	})

	it("lowercases an uppercase legacy path letter before applying the d/f swap", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/D/${UUID}%23${KEY_HEX}`)).toEqual({
			uuid: UUID,
			key: KEY_PLAINTEXT,
			type: "file"
		})
	})
})

describe("parseFilenPublicLink — rejections", () => {
	it("rejects a non-Filen host", () => {
		expect(parseFilenPublicLink(`https://evil.example.com/f/${UUID}#${KEY_HEX}`)).toBeNull()
	})

	it("rejects an unknown route letter", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/x/${UUID}#${KEY_HEX}`)).toBeNull()
	})

	it("rejects a malformed uuid", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/f/not-a-uuid#${KEY_HEX}`)).toBeNull()
	})

	it("rejects a non-hex key in the new format", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/f/${UUID}#not-hex`)).toBeNull()
	})

	it("rejects a missing key", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/f/${UUID}`)).toBeNull()
	})

	it("rejects a plain non-Filen url", () => {
		expect(parseFilenPublicLink("https://example.com/photo.png")).toBeNull()
	})

	it("rejects an empty url", () => {
		expect(parseFilenPublicLink("")).toBeNull()
	})

	it("rejects a legacy raw key under the minimum captured length", () => {
		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}%23short`)).toBeNull()
	})

	it("rejects a legacy raw key that clears the regex minimum but isn't exactly 32 bytes decoded", () => {
		const rawKey = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456"

		expect(parseFilenPublicLink(`https://app.filen.io/#/d/${UUID}%23${rawKey}`)).toBeNull()
	})
})
