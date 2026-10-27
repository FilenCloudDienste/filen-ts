import { openOdp, type OdpParts } from "../../../../core/odp/read/document"
import type { Deck } from "../../../../core/presentation/model"
import type { OpenCapability } from "../../engine"

// Opens an OpenDocument presentation (.odp, .otp) into a session, from bytes or a range source. Pages are parsed on
// demand through the deck's parts (odpParts), which the view capability reads like a PresentationML deck's. An
// encrypted package is refused "encrypted" (ODF encryption is not opened, as for ODT and ODS).

const parts = new WeakMap<Deck, OdpParts>()

// The parts of a deck this opener opened (the package, the scanned content, the lazy page parse), or undefined.
export function odpParts(deck: Deck): OdpParts | undefined {
	return parts.get(deck)
}

// After a save's rebase the deck reads through the parts of its saved file.
export function bindOdpParts(deck: Deck, odp: OdpParts): void {
	parts.set(deck, odp)
}

export const openOdpCapability: OpenCapability = {
	async open(request) {
		const opened = await openOdp(request.source)

		if (opened.kind === "refused") return opened

		parts.set(opened.deck, opened.parts)

		return {
			kind: "opened",
			deck: opened.deck,
			package: {
				format: "odp",
				variant: opened.deck.variant,
				bytes: request.source.size,
				source: request.source,
				sourceKind: request.sourceKind,
				archive: opened.parts.odf.archive,
				locks: 0
			}
		}
	}
}
