import { OpcPackage, partKey, PRESENTATION_ZIP_LIMITS, type ByteSource } from "../../../core/opc/index"
import { PresentationError, type Deck } from "../../../core/presentation/model"
import { pptxSpliceWriter } from "../../../core/pptx/write/save"
import type { PptxSpliceSource } from "../../../core/pptx/write/splice"
import type { XmlDocument } from "../../../core/xml/index"
import { packageSealer, type PackageSealer } from "../../encryption/seal"
import type { EngineSession, OpenedPackage, SaveCapability } from "../engine"
import {
	commitSavedSession,
	packageSource,
	rebindSources,
	saveSession,
	type SaveDependencies,
	type SavedPackage,
	type SealPackage
} from "../save"
import { sessionEdits } from "./edit"
import { pptxDecrypted, pptxParts } from "./open/pptx"

// The save capability: save() streams the session's changes to the upload's port, commitSaved() moves the session
// onto the file the upload made (save.ts). Each format brings its writer and its rebase.

// A pptx session onto its saved file: the package re-opened over it with the limits it opened with, the documents of
// the parts the save rewrote read again and the model's refs rebound into them, every other parsed document kept
// (same bytes, same nodes), and the next epoch for everything parsed from now on.
export async function rebasePptx(session: EngineSession, source: ByteSource, saved: SavedPackage): Promise<OpenedPackage> {
	const parts = pptxParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "rebase without the deck's parts")

	const opc = await OpcPackage.open(source, { limits: { ...PRESENTATION_ZIP_LIMITS, maxEntries: parts.budgets.zipEntries } })
	const contentTypes = await opc.contentTypes()
	const epoch = parts.epoch + 1
	const rewritten = new Map<string, { readonly from: XmlDocument; readonly to: XmlDocument }>()
	const documents = new Map<string, XmlDocument | undefined>()

	for (const name of saved.written) {
		const part = `/${name}`
		const from = parts.document(part)

		if (from === undefined || !opc.has(name)) {
			documents.set(part, undefined)

			continue
		}

		const to = await opc.xml(name)

		rewritten.set(partKey(part), { from, to })
		documents.set(part, to)
	}

	for (const entry of session.package.archive?.entries ?? []) {
		if (!opc.has(entry.name)) documents.set(`/${entry.name}`, undefined)
	}

	// Read before the swap, so the swap itself stays one synchronous step.
	const plan = await parts.prepareRebase(opc)

	rebindSources(session.deck, epoch, rewritten)
	parts.rebase(opc, contentTypes, epoch, documents, plan)

	return { ...session.package, bytes: source.size, source, archive: opc.zip, opc }
}

// One sealer per encrypted deck, over the key its session unlocked (the session's close releases that key).
const sealers = new WeakMap<Deck, PackageSealer>()

// An encrypted pptx's save sealed as Agile under its key; the sealer reads the sealed file back before answering.
export const sealPptx: SealPackage = (zip, deck, slicing) => {
	const decrypted = pptxDecrypted(deck)

	if (decrypted === undefined) return Promise.reject(new PresentationError("notImplemented", "seal without the deck's key"))

	let sealer = sealers.get(deck)

	if (sealer === undefined) {
		sealer = packageSealer(decrypted.key).sealer
		sealers.set(deck, sealer)
	}

	return sealer.seal(zip, { slicing })
}

// The session's package with the deck's part map (a slide's part and p:sldId, parsed or not).
// After a rebase, markup an undo re-read is held by the edit session under "raw:N" names: the writer reads it there.
export function pptxSaveSource(session: EngineSession): PptxSpliceSource {
	const index = pptxParts(session.deck)

	// Asked only for a "raw:" source, which only the edit session makes: never creates one.
	return {
		...packageSource(session),
		...(index === undefined ? {} : { index }),
		raw: {
			document: name => sessionEdits(session).rawDocument(name),
			part: name => sessionEdits(session).rawPart(name),
			parts: name => sessionEdits(session).rawParts(name)
		}
	}
}

export const SAVE_DEPENDENCIES: SaveDependencies = {
	savers: { pptx: { writer: pptxSpliceWriter, source: pptxSaveSource, seal: sealPptx } },
	rebasers: { pptx: rebasePptx }
}

export const saveCapability: SaveCapability = {
	save: (context, options) => saveSession(context, options, SAVE_DEPENDENCIES),
	commitSaved: (context, options) => commitSavedSession(context, options, SAVE_DEPENDENCIES)
}
