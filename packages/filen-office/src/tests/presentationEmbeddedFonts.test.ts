import { describe, expect, it } from "vitest"
import { FontManager, readSfnt } from "../core/fonts/index"
import type { Deck } from "../core/presentation/model"
import type { EngineSession } from "../dom/presentation/engine"
import { declareEmbeddedFonts, embeddedFontRefusals, fontsCapability, loadEmbeddedFaces } from "../dom/presentation/engine/fonts"
import { corpusFonts } from "./embeddedFontFixtures"
import { nodeFontAssets } from "./layoutFixtures"

const FONTS = corpusFonts()
const BOLDONSE = FONTS.find(font => font.name.includes("Boldonse"))

function session(): { session: EngineSession; close(): void } {
	const closers: (() => void)[] = []
	const deck = {
		embeddedFonts: [{ typeface: "Boldonse", regular: "/ppt/fonts/font1.fntdata", bold: "/ppt/fonts/font2.fntdata" }]
	} as unknown as Deck

	return {
		session: { s: 1, deck, onClose: (listener: () => void) => closers.push(listener) } as unknown as EngineSession,
		close: () => {
			for (const closer of closers) closer()
		}
	}
}

describe.skipIf(BOLDONSE === undefined)("a deck's embedded fonts", () => {
	it("decodes the parts text needs, serves them under the session's aliases, and refuses an undecodable one alone", async () => {
		const parts: Record<string, Uint8Array> = {
			"/ppt/fonts/font1.fntdata": BOLDONSE?.bytes ?? new Uint8Array(0),
			// Not a font: the bold style is refused, typed, and the regular one still serves.
			"/ppt/fonts/font2.fntdata": new Uint8Array(300)
		}
		const added: string[] = []
		const host = {
			addBytes: (face: { family: string }, bytes: Uint8Array) => {
				readSfnt(bytes)
				added.push(face.family)

				return Promise.resolve(true)
			},
			addLocal: () => Promise.resolve(false),
			remove: () => undefined
		}
		const manager = new FontManager(host, nodeFontAssets, undefined, "test")
		const { session: engineSession, close } = session()
		const reads: string[] = []

		declareEmbeddedFonts(engineSession, manager, part => {
			reads.push(part)

			return Promise.resolve(parts[part])
		})

		// Nothing is read before text asks.
		expect(reads).toEqual([])
		expect(await fontsCapability.faces(engineSession)).toEqual([])

		await loadEmbeddedFaces(engineSession)

		const faces = await fontsCapability.faces(engineSession)

		expect(faces.length).toBe(1)
		expect(faces[0]).toMatchObject({ kind: "bytes", face: { family: added[0], weight: 400, italic: false } })
		expect(readSfnt(faces[0]?.kind === "bytes" ? faces[0].bytes : new Uint8Array(0)).numGlyphs).toBeGreaterThan(0)
		expect(embeddedFontRefusals(engineSession)).toEqual([{ family: "Boldonse", bold: true, italic: false, reason: "notSfnt" }])
		// Bold text draws in the regular face (the closest the family has), not in a substitute.
		expect(manager.resolve({ family: "Boldonse", bold: true, italic: false, slot: "ascii" }).source).toBe("embedded")

		close()

		expect(await fontsCapability.faces(engineSession)).toEqual([])
		manager.dispose()
	})
})
