import { pptToPptx } from "../../../../core/ppt/toPptx"
import type { PptLoss } from "../../../../core/ppt/report"
import { openPptxPackage } from "../../../../core/pptx/package"
import type { Deck, DeckVariant } from "../../../../core/presentation/model"
import { decryptionOf } from "../../../encryption/legacyDecryption"
import type { OpenCapability } from "../../engine"
import { registerPptxParts } from "./pptx"

// Opens a PowerPoint 97–2003 deck (.ppt, .pps, .pot) into a session, view-only: the file is converted to an in-memory
// pptx (core/ppt/toPptx.ts) in this worker, which keeps the password, and the pptx reader opens that, so every other
// capability reads it as a pptx. An encrypted file asks for its password; a wrong one asks again. Edits and saves in
// place are refused viewOnly; Save as writes a new file.

const losses = new WeakMap<Deck, readonly PptLoss[]>()

// What the conversion of a ppt deck could not carry over, by kind (Save as and the viewer's notice read it).
export function pptLosses(deck: Deck): readonly PptLoss[] | undefined {
	return losses.get(deck)
}

const VARIANTS: ReadonlyMap<string, DeckVariant> = new Map([
	["ppt", "ppt"],
	["pps", "pps"],
	["pot", "pot"]
])

function variantOf(fileName: string): DeckVariant {
	const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()

	return VARIANTS.get(extension) ?? "ppt"
}

export const openPptCapability: OpenCapability = {
	async open(request) {
		const converted = await pptToPptx(
			request.source,
			request.password === undefined ? {} : { decryption: decryptionOf(request.password) }
		)

		if (converted.kind === "refused") {
			// The engine answers needsPassword with wrongPassword when a password was given.
			return converted.reason === "needsPassword" || converted.reason === "wrongPassword" ? { kind: "needsPassword" } : converted
		}

		let opened

		try {
			opened = await openPptxPackage(converted.pptx, converted.encrypted ? { encrypted: { scheme: "rc4CryptoApi" } } : {})
		} catch (error) {
			converted.release()

			throw error
		}

		if (opened.kind === "refused") {
			converted.release()

			return opened
		}

		const { deck } = opened

		deck.format = "ppt"
		deck.variant = variantOf(request.options.fileName)
		registerPptxParts(deck, opened.parts)
		losses.set(deck, converted.losses)

		return {
			kind: "opened",
			deck,
			package: {
				format: "ppt",
				variant: deck.variant,
				bytes: request.source.size,
				source: request.source,
				sourceKind: request.sourceKind,
				opc: opened.parts.opc,
				locks: 0,
				// The key stays for the pictures, decrypted as they are read, until the session closes.
				release: converted.release,
				viewOnly: true
			}
		}
	}
}
