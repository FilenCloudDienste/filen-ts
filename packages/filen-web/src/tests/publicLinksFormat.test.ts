import { Buffer } from "buffer"
import { describe, expect, it } from "vitest"
import { parsePublicLink, buildPublicLinkUrl, resolveRouteLink, deriveLegacyRedirect } from "@/features/publicLinks/lib/format.logic"

// Version 4 (third group starts "4"), variant 8 (fourth "8") — parsePublicLink now delegates to
// @filen/shared's parseFilenPublicLink, which validates both nibbles via the 'uuid' package.
const UUID = "11111111-2222-4333-8444-555555555555"
// A realistic 32-char plaintext key → 64 hex chars, comfortably above the route's min-fragment floor.
const KEY_PLAINTEXT = "0123456789abcdef0123456789abcdef"
const KEY_HEX = Buffer.from(KEY_PLAINTEXT, "utf-8").toString("hex")

// parsePublicLink's own format-recognition cases (new/legacy eras, rejections) live in
// @filen/shared's src/tests/publicLink.test.ts, against the parseFilenPublicLink it delegates to.
// This file keeps only what stays web-local: building links and route-side resolution.

describe("buildPublicLinkUrl", () => {
	it("builds the NEW file format (/f/, hex key in a literal-# fragment)", () => {
		expect(buildPublicLinkUrl("file", UUID, KEY_PLAINTEXT)).toBe(`https://app.filen.io/f/${UUID}#${KEY_HEX}`)
	})

	it("builds the NEW directory format (/d/, hex key in a literal-# fragment)", () => {
		expect(buildPublicLinkUrl("directory", UUID, KEY_PLAINTEXT)).toBe(`https://app.filen.io/d/${UUID}#${KEY_HEX}`)
	})

	it("round-trips through parsePublicLink for a file", () => {
		expect(parsePublicLink(buildPublicLinkUrl("file", UUID, KEY_PLAINTEXT))).toEqual({ kind: "file", uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("round-trips through parsePublicLink for a directory", () => {
		expect(parsePublicLink(buildPublicLinkUrl("directory", UUID, KEY_PLAINTEXT))).toEqual({
			kind: "directory",
			uuid: UUID,
			key: KEY_PLAINTEXT
		})
	})
})

describe("resolveRouteLink — uuid from the path param, key from the fragment", () => {
	it("decodes a hex key carried in the URL fragment", () => {
		expect(resolveRouteLink(UUID, `#${KEY_HEX}`)).toEqual({ uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("lowercases the uuid and tolerates a fragment with no leading #", () => {
		expect(resolveRouteLink(UUID.toUpperCase(), KEY_HEX)).toEqual({ uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("defensively recovers a key that landed in the path param via %23", () => {
		expect(resolveRouteLink(`${UUID}%23${KEY_HEX}`, "")).toEqual({ uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("accepts a legacy raw (non-hex) key verbatim when it is long enough", () => {
		const rawKey = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"

		expect(resolveRouteLink(UUID, `#${rawKey}`)).toEqual({ uuid: UUID, key: rawKey })
	})

	it("rejects a malformed uuid", () => {
		expect(resolveRouteLink("not-a-uuid", `#${KEY_HEX}`)).toBeNull()
	})

	it("rejects a missing fragment", () => {
		expect(resolveRouteLink(UUID, "")).toBeNull()
	})

	it("rejects a too-short key fragment", () => {
		expect(resolveRouteLink(UUID, "#abcd")).toBeNull()
	})
})

describe("deriveLegacyRedirect — legacy hash → new swapped target", () => {
	it("legacy /f/ (directory) → new directory target, key verbatim", () => {
		expect(deriveLegacyRedirect(`#/f/${UUID}%23${KEY_HEX}`)).toEqual({ kind: "directory", uuid: UUID, key: KEY_HEX })
	})

	it("legacy /d/ (file) → new file target, key verbatim", () => {
		expect(deriveLegacyRedirect(`#/d/${UUID}#${KEY_HEX}`)).toEqual({ kind: "file", uuid: UUID, key: KEY_HEX })
	})

	it("preserves a raw legacy key verbatim (no re-encoding)", () => {
		const rawKey = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"

		expect(deriveLegacyRedirect(`#/d/${UUID}%23${rawKey}`)).toEqual({ kind: "file", uuid: UUID, key: rawKey })
	})

	it("returns null for a non-link hash", () => {
		expect(deriveLegacyRedirect("#section-heading")).toBeNull()
	})

	it("returns null for an empty hash", () => {
		expect(deriveLegacyRedirect("")).toBeNull()
	})

	it("returns null for a legacy shape with no key", () => {
		expect(deriveLegacyRedirect(`#/f/${UUID}`)).toBeNull()
	})
})
