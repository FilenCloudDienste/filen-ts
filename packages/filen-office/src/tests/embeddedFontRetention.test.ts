import { gunzipSync } from "fflate"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FontManager } from "../core/fonts/index"
import type { Deck } from "../core/presentation/model"
import type { EngineSession } from "../dom/presentation/engine"
import { declareEmbeddedFonts, embeddedFontRefusals, loadEmbeddedFaces } from "../dom/presentation/engine/fonts"
import { nodeFontAssets } from "./layoutFixtures"
import { liveHeap } from "./liveHeap"

// A deck may embed any number of fonts: the faces it cannot use (not fonts, or fonts the platform rejects) must not
// stay in memory, so the embedded budget (96 MiB of faces in use) bounds what the session holds.

const MiB = 1024 * 1024
const COUNT = 24
const SIZE = 16 * MiB
const ARIMO = gunzipSync(readFileSync(join(import.meta.dirname, "..", "..", "assets", "fonts", "arimo", "Arimo-Regular.ttf.gz")))

function session(): EngineSession {
	const embeddedFonts = Array.from({ length: COUNT }, (_, i) => ({
		typeface: `Hostile${String(i)}`,
		regular: `/ppt/fonts/font${String(i)}.fntdata`
	}))

	return { s: 1, deck: { embeddedFonts } as unknown as Deck, onClose: () => undefined } as unknown as EngineSession
}

async function retained(part: (limit: number) => Uint8Array): Promise<{ held: number; refusals: number }> {
	const host = { addBytes: () => Promise.resolve(false), addLocal: () => Promise.resolve(false), remove: () => undefined }
	const manager = new FontManager(host, nodeFontAssets, undefined, "test")
	const engine = session()
	const before = await liveHeap()

	declareEmbeddedFonts(engine, manager, (_name, limit) => Promise.resolve(part(limit)))
	await loadEmbeddedFaces(engine)

	const held = (await liveHeap()) - before
	const refusals = embeddedFontRefusals(engine).length

	manager.dispose()

	return { held, refusals }
}

describe("refused embedded fonts", () => {
	it("are let go when the platform rejects them", { timeout: 60_000 }, async () => {
		// A real TrueType font padded to 16 MiB, which the platform then rejects: 384 MiB read in all.
		const { held } = await retained(limit => {
			const bytes = new Uint8Array(Math.min(SIZE, limit))

			bytes.set(ARIMO)

			return bytes
		})

		expect(held).toBeLessThan(16 * MiB)
	})

	it("are let go when they are no font, their refusal recorded without the bytes", { timeout: 60_000 }, async () => {
		const { held, refusals } = await retained(limit => new Uint8Array(Math.min(SIZE, limit)))

		expect(refusals).toBe(COUNT)
		expect(held).toBeLessThan(16 * MiB)
	})
})
