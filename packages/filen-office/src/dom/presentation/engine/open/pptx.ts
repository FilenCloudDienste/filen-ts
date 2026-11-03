import { bytesSource, type ByteSource, type ZipArchive } from "../../../../core/opc/index"
import { openPptx, type PptxParts } from "../../../../core/pptx/package"
import { refused, type Deck, type EncryptionInfoSummary } from "../../../../core/presentation/model"
import { openEncryptedPackage, type DecryptedPackage } from "../../../encryption/index"
import type { OpenCapability, OpenOutcome, OpenRequest } from "../../engine"

// Opens a PresentationML deck (pptx, pptm, potx, potm, ppsx, ppsm) into a session, from bytes or a range source. A
// password-protected package (MS-OFFCRYPTO: an OLE2 container around the encrypted zip) is classified first: rights-
// managed and unsupported schemes are refused from their structure, an encrypted one asks for the password and is
// decrypted here, in the worker that keeps the key; the decrypted zip opens like any other, its scheme on the deck.
// Slides are parsed on demand through the deck's parts (pptxParts), which the other capabilities read.

const parts = new WeakMap<Deck, PptxParts>()
const decrypted = new WeakMap<Deck, DecryptedPackage>()

// The parts of a deck this opener opened (parsed documents, themes, the lazy slide parse), or undefined.
export function pptxParts(deck: Deck): PptxParts | undefined {
	return parts.get(deck)
}

// Registers the parts of a deck opened from a package another opener built (a PowerPoint 97–2003 deck through the
// in-memory pptx it converts to), so every capability reads it as it reads a pptx.
export function registerPptxParts(deck: Deck, opened: PptxParts): void {
	parts.set(deck, opened)
}

const passwords = new WeakMap<Deck, string>()

export function pptxPassword(deck: Deck): string | undefined {
	return passwords.get(deck)
}

// The decrypted package of an encrypted deck (its key seals the next save), or undefined.
export function pptxDecrypted(deck: Deck): DecryptedPackage | undefined {
	return decrypted.get(deck)
}

function archiveOf(parts: PptxParts): ZipArchive | undefined {
	try {
		return parts.opc.zip
	} catch {
		// A package from parts in memory has no archive.
		return undefined
	}
}

async function openSource(request: OpenRequest, source: ByteSource, encrypted?: DecryptedPackage): Promise<OpenOutcome> {
	const summary: EncryptionInfoSummary | undefined = encrypted === undefined ? undefined : { scheme: encrypted.scheme }
	const opened = await openPptx(source, summary === undefined ? {} : { encrypted: summary })

	if (opened.kind === "refused") {
		encrypted?.release()

		return opened
	}

	const { deck } = opened

	parts.set(deck, opened.parts)

	if (encrypted !== undefined) decrypted.set(deck, encrypted)

	const archive = archiveOf(opened.parts)

	return {
		kind: "opened",
		deck,
		package: {
			format: "pptx",
			variant: deck.variant,
			bytes: request.source.size,
			source: request.source,
			sourceKind: request.sourceKind,
			...(archive === undefined ? {} : { archive }),
			opc: opened.parts.opc,
			locks: 0,
			// The session drops the key and the open password when it closes.
			...(encrypted === undefined
				? {}
				: {
						release: () => {
							passwords.delete(deck)
							decrypted.delete(deck)
							encrypted.release()
						}
					})
		}
	}
}

export const openPptxCapability: OpenCapability = {
	async open(request) {
		const sealed = await openEncryptedPackage(request.source)

		switch (sealed.kind) {
			case "plain":
				return openSource(request, request.source)
			case "refused":
				return sealed.reason === "rightsManaged"
					? refused("rightsManaged", "A rights-managed (IRM) presentation")
					: sealed.reason === "unsupported"
						? refused("unsupportedEncryption", "An encryption this app does not open")
						: refused("damagedEncryption", "The encrypted package is damaged")
			case "aborted":
				return refused("aborted", "open")
			case "unlocked":
				return openSource(request, bytesSource(sealed.document.bytes), sealed.document)
			case "needsPassword": {
				if (request.password === undefined) return { kind: "needsPassword" }

				const unlocked = await sealed.locked.unlock(request.password)

				if (unlocked.ok) {
					const outcome = await openSource(request, bytesSource(unlocked.document.bytes), unlocked.document)

					if (outcome.kind === "opened") passwords.set(outcome.deck, request.password)

					return outcome
				}
				if (unlocked.reason === "wrongPassword") return { kind: "needsPassword" }
				if (unlocked.reason === "aborted") return refused("aborted", "unlock")
				if (unlocked.reason === "rightsManaged") return refused("rightsManaged", "A rights-managed (IRM) presentation")

				return refused(unlocked.reason === "unsupported" ? "unsupportedEncryption" : "damagedEncryption", "unlock")
			}
		}
	}
}
