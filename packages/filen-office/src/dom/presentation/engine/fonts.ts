import { embeddedFontData } from "../../../core/fonts/eot"
import {
	FontError,
	type EmbeddedFontReader,
	type FaceRegistration,
	type FontErrorCode,
	type FontManager,
	type FontRequest
} from "../../../core/fonts/index"
import type { DocxFontFace } from "../../docx/protocol"
import type { EngineSession, FontsCapability } from "../engine"

// The fonts a deck embeds (p:embeddedFontLst, ECMA-376 Part 1 §19.2.1.9: one font part per style, Embedded OpenType
// with MicroType Express compression, or a plain TrueType font), declared to the session's font manager so its text is
// measured and drawn in them. A part is read and decoded only when text first needs its face; a part that does not
// decode refuses that face alone (a FontError the manager records with the family and style), and that text falls back
// to the font's substitute. The decoded faces are what the page and the jobs worker register too (faces(), and the
// view's "fonts" events through embeddedFaceBytes).

// Reads a package part, at most `limit` bytes of it (undefined when the package has no such part or it is larger).
export type PartReader = (part: string, limit: number) => Promise<Uint8Array | undefined>

const STYLES = [
	["regular", false, false],
	["bold", true, false],
	["italic", false, true],
	["boldItalic", true, true]
] as const

interface SessionFonts {
	readonly manager: FontManager
	// A request for each embedded style.
	readonly styles: FontRequest[]
	// The styles whose part did not decode, and why.
	readonly refused: EmbeddedFontRefusal[]
}

// An embedded style that is not used: its family and style, and the typed reason its part was refused.
export interface EmbeddedFontRefusal {
	readonly family: string
	readonly bold: boolean
	readonly italic: boolean
	readonly reason: FontErrorCode
}

const sessions = new WeakMap<EngineSession, SessionFonts>()

// Declares every embedded style of the session's deck to `fonts` (the session's measuring manager), each part read
// through `read` when text first needs its face.
export function declareEmbeddedFonts(session: EngineSession, fonts: FontManager, read: PartReader): void {
	const held: SessionFonts = { manager: fonts, styles: [], refused: [] }

	sessions.set(session, held)
	session.onClose(() => {
		sessions.delete(session)
	})

	for (const font of session.deck.embeddedFonts) {
		const family = font.typeface

		for (const [style, bold, italic] of STYLES) {
			const part = font[style]

			if (part === undefined) continue

			const reader: EmbeddedFontReader = async maxBytes => {
				try {
					// An EOT is smaller than the font it holds: the part is read within the budget, the decoded font held to it.
					const bytes = await read(part, maxBytes)

					if (bytes === undefined)
						throw new FontError("tooLarge", `The embedded font part ${part} is missing or over the size limit`)

					// Handed to the manager, which keeps it only once the platform takes the face (within its budget).
					return embeddedFontData(bytes, { maxFontBytes: maxBytes })
				} catch (error) {
					if (error instanceof FontError) held.refused.push({ family, bold, italic, reason: error.code })

					throw error
				}
			}

			fonts.embed(family, bold, italic, reader)
			held.styles.push({ family, bold, italic, slot: "ascii" })
		}
	}
}

// Loads every embedded style of the session's deck (an export draws text the session may not have laid out yet, and
// its font list is taken before its pages): the faces that decode are registered, the rest refused as each was.
export async function loadEmbeddedFaces(session: EngineSession): Promise<void> {
	const held = sessions.get(session)

	if (held !== undefined && held.styles.length > 0) await held.manager.prepare(held.styles)
}

// The embedded styles refused so far (each refuses only itself: the rest of the family and the deck draw on).
export function embeddedFontRefusals(session: EngineSession): readonly EmbeddedFontRefusal[] {
	return sessions.get(session)?.refused ?? []
}

// The decoded font of an embedded face the session's manager registered, for the realms that draw it; undefined for
// any other face.
export function embeddedFaceBytes(session: EngineSession, registration: FaceRegistration): Uint8Array | undefined {
	return sessions.get(session)?.manager.embeddedData(registration)
}

// The decoded embedded faces loaded so far, under the aliases the session's text uses; each call hands out copies
// (a sender hands off what it sends).
export const fontsCapability: FontsCapability = {
	faces(session) {
		const held = sessions.get(session)
		const faces: DocxFontFace[] = []

		for (const registration of held?.manager.registrations() ?? []) {
			const bytes = embeddedFaceBytes(session, registration)

			if (bytes !== undefined) {
				faces.push({
					kind: "bytes",
					face: { family: registration.family, weight: registration.weight, italic: registration.italic },
					bytes: bytes.slice()
				})
			}
		}

		return Promise.resolve(faces)
	}
}
