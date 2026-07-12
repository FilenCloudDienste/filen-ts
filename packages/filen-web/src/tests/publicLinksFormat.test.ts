import { Buffer } from "buffer"
import { describe, expect, it } from "vitest"
import { parsePublicLink, buildPublicLinkUrl, resolveRouteLink, deriveLegacyRedirect } from "@/features/publicLinks/lib/format.logic"

const UUID = "11111111-2222-3333-4444-555555555555"
// A realistic 32-char plaintext key → 64 hex chars, comfortably above the route's min-fragment floor.
const KEY_PLAINTEXT = "0123456789abcdef0123456789abcdef"
const KEY_HEX = Buffer.from(KEY_PLAINTEXT, "utf-8").toString("hex")

describe("parsePublicLink — new path format (letters swapped from legacy)", () => {
	it("recognizes /f/ as a FILE", () => {
		expect(parsePublicLink(`https://app.filen.io/f/${UUID}#${KEY_HEX}`)).toEqual({ kind: "file", uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("recognizes /d/ as a DIRECTORY", () => {
		expect(parsePublicLink(`https://app.filen.io/d/${UUID}#${KEY_HEX}`)).toEqual({
			kind: "directory",
			uuid: UUID,
			key: KEY_PLAINTEXT
		})
	})

	it("accepts a %23-encoded separator too", () => {
		expect(parsePublicLink(`https://app.filen.io/f/${UUID}%23${KEY_HEX}`)).toEqual({ kind: "file", uuid: UUID, key: KEY_PLAINTEXT })
	})
})

describe("parsePublicLink — legacy hash format (letters swapped: f=dir, d=file)", () => {
	it("recognizes legacy /d/ as a FILE", () => {
		expect(parsePublicLink(`https://app.filen.io/#/d/${UUID}%23${KEY_HEX}`)).toEqual({ kind: "file", uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("recognizes legacy /f/ as a DIRECTORY", () => {
		expect(parsePublicLink(`https://app.filen.io/#/f/${UUID}%23${KEY_HEX}`)).toEqual({
			kind: "directory",
			uuid: UUID,
			key: KEY_PLAINTEXT
		})
	})

	it("accepts a legacy literal # separator", () => {
		expect(parsePublicLink(`https://app.filen.io/#/d/${UUID}#${KEY_HEX}`)).toEqual({ kind: "file", uuid: UUID, key: KEY_PLAINTEXT })
	})

	it("accepts the drive.filen.io legacy host", () => {
		expect(parsePublicLink(`https://drive.filen.io/#/d/${UUID}%23${KEY_HEX}`)).toEqual({ kind: "file", uuid: UUID, key: KEY_PLAINTEXT })
	})
})

describe("parsePublicLink — rejections", () => {
	it("rejects a non-Filen host", () => {
		expect(parsePublicLink(`https://evil.example.com/f/${UUID}#${KEY_HEX}`)).toBeNull()
	})

	it("rejects an unknown route letter", () => {
		expect(parsePublicLink(`https://app.filen.io/x/${UUID}#${KEY_HEX}`)).toBeNull()
	})

	it("rejects a malformed uuid", () => {
		expect(parsePublicLink(`https://app.filen.io/f/not-a-uuid#${KEY_HEX}`)).toBeNull()
	})

	it("rejects a non-hex key", () => {
		expect(parsePublicLink(`https://app.filen.io/f/${UUID}#not-hex`)).toBeNull()
	})

	it("rejects a missing key", () => {
		expect(parsePublicLink(`https://app.filen.io/f/${UUID}`)).toBeNull()
	})

	it("rejects a plain non-Filen url", () => {
		expect(parsePublicLink("https://example.com/photo.png")).toBeNull()
	})
})

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
