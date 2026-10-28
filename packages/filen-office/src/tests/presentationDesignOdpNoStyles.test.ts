import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Background } from "../core/presentation/model"
import { zipParts } from "../core/templates/zip"
import { driveSession } from "./odpWriteDrive"
import { odpApplier, openOdpDeck } from "./odpWriteFixtures"

// An ODP package without styles.xml (ODF 1.3 Part 2 §3.1 makes it optional): what a design op puts in styles.xml
// (a gallery master page, the page layouts' size, a gradient, pattern or picture as a drawing resource) has nowhere
// to go. Such an op is refused when it is sent, naming the missing part, so the deck never holds a change its save
// would refuse. Changes that live in content.xml alone (a solid page background) are kept and saved.

const MANIFEST =
	'<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
	'<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>' +
	'<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'

const CONTENT =
	'<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
	'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:presentation>' +
	'<draw:page draw:name="page1"><draw:frame draw:name="Title" svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm">' +
	"<draw:text-box><text:p>Test</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>"

function stylesless(): Promise<Uint8Array> {
	return zipParts([
		["mimetype", "application/vnd.oasis.opendocument.presentation", "stored"],
		["META-INF/manifest.xml", MANIFEST],
		["content.xml", CONTENT]
	])
}

const STOPS = [
	{ pos: 0, color: { kind: "srgb", rgb: "112233" } },
	{ pos: 100_000, color: { kind: "srgb", rgb: "AABBCC" } }
] as const

function background(fill: unknown): DeckOp {
	return { family: "design", kind: "setBackground", slides: "all", background: { kind: "fill", fill } as Background } as DeckOp
}

const REFUSED: readonly (readonly [string, DeckOp])[] = [
	["a gallery theme", { family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 0 } }],
	["a scaled size change", { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" }],
	["an unscaled size change", { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "none" }],
	["a gradient background", background({ kind: "gradient", stops: STOPS, linear: { angle: 0, scaled: false } })],
	[
		"a pattern background",
		background({ kind: "pattern", preset: "pct50", fg: { kind: "srgb", rgb: "000000" }, bg: { kind: "srgb", rgb: "FFFFFF" } })
	]
]

describe("design ops on an ODP package without styles.xml", () => {
	for (const [what, op] of REFUSED)
		it(`refuses ${what} when it is sent, naming styles.xml, and leaves the deck clean`, async () => {
			const d = await driveSession(await stylesless())
			const result = await d.command(op)

			expect(result).toMatchObject({ ok: false, refusal: "unsupported" })
			expect((await d.save()).result.kind).toBe("unchanged")
			expect(odpApplier(await openOdpDeck(await stylesless()))(op)).toEqual({
				kind: "refused",
				reason: "unsupported",
				detail: "a package without styles.xml"
			})
		})

	it("keeps and saves a solid page background, which content.xml holds", async () => {
		const d = await driveSession(await stylesless())

		expect((await d.command(background({ kind: "solid", color: { kind: "srgb", rgb: "336699" } }))).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
	})
})
