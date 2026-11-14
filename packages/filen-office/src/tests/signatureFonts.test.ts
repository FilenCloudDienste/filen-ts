import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { readSfnt, type SfntFont } from "@filen/office/core/fonts"
import { ASSETS, readManifest } from "../scripts/fontTables"
import { sfntFromWoff2 } from "../scripts/woff2Tables"

// The handwriting families of the PDF signature dialog's Type tab (assets/fonts/manifest.json "signatures"): the
// files are the recorded ones, the unicodeRange the app registers each face with is exactly its cmap's coverage (so
// the browser falls back for any other character instead of drawing a missing glyph), and every face covers the
// letters of Latin-1 and Latin Extended-A.

const signatures = readManifest().signatures

function coverage(font: SfntFont): string {
	const ranges: [number, number][] = []

	for (let codePoint = 0x20; codePoint <= 0x10ffff; codePoint++) {
		if (!font.hasGlyph(codePoint)) continue

		const last = ranges.at(-1)

		if (last?.[1] === codePoint - 1) last[1] = codePoint
		else ranges.push([codePoint, codePoint])
	}

	const hex = (codePoint: number) => codePoint.toString(16).toUpperCase().padStart(4, "0")

	return ranges.map(([from, to]) => (from === to ? `U+${hex(from)}` : `U+${hex(from)}-${hex(to)}`)).join(",")
}

// Letters a face lacks, each rare (archaic or a compatibility ligature) and drawn by the fallback.
const KNOWN_GAPS: Record<string, string> = {
	"dancing-script": "ſ",
	"ms-madi": "Ĳĳŉſ",
	"pinyon-script": "ŉ"
}

describe("signature fonts", () => {
	it("are three distinct families, none of them a document substitute", () => {
		const ids = signatures.map(family => family.id)

		expect(ids).toEqual(["dancing-script", "ms-madi", "pinyon-script"])
		expect(readManifest().families.some(family => ids.includes(family.id))).toBe(false)
	})

	for (const family of signatures) {
		describe(family.name, () => {
			const face = family.faces[0]

			it("ships the recorded upstream file and its OFL", () => {
				expect(family.faces).toHaveLength(1)

				if (face === undefined) return

				const bytes = readFileSync(`${ASSETS}${face.file}`)
				const sha256 = createHash("sha256").update(bytes).digest("hex")

				expect({ bytes: bytes.byteLength, sha256 }).toEqual({ bytes: face.bytes, sha256: face.sha256 })
				// Unchanged upstream WOFF2 (not a Modified Version under the OFL).
				expect(face.upstream.sha256).toBe(face.sha256)
				expect(face.upstream.url).toContain(family.commit)

				const licence = readFileSync(`${ASSETS}${family.licenseFile}`, "utf8")

				expect(licence).toMatch(/^Copyright /)
				expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1")
				expect(licence.split("\n")[0]?.includes("Reserved Font Name")).toBe(family.reservedFontName !== null)
			})

			it("records its cmap's coverage as the unicodeRange", () => {
				if (face === undefined) return

				const font = readSfnt(sfntFromWoff2(new Uint8Array(readFileSync(`${ASSETS}${face.file}`))))

				expect(font.names.typographicFamily ?? font.names.family).toBe(family.name)
				expect(font.fsType).toBe(0)
				expect(coverage(font)).toBe(face.unicodeRange)
			})

			it("covers Latin-1 and Latin Extended-A letters", () => {
				if (face === undefined) return

				const font = readSfnt(sfntFromWoff2(new Uint8Array(readFileSync(`${ASSETS}${face.file}`))))
				const missing: string[] = []

				for (let codePoint = 0xc0; codePoint <= 0x17f; codePoint++) {
					if (codePoint === 0xd7 || codePoint === 0xf7) continue
					if (!font.hasGlyph(codePoint)) missing.push(String.fromCodePoint(codePoint))
				}

				expect(missing.join("")).toBe(KNOWN_GAPS[family.id])

				for (const character of "Zoë Łukasz Ştefan Șerban Țară Dvořák Żółć Œuvre") {
					expect(font.hasGlyph(character.codePointAt(0) ?? 0), character).toBe(true)
				}
			})
		})
	}
})
