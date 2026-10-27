import { OpcPackage, partKey, PRESENTATION_ZIP_LIMITS, type ByteSource } from "../../../core/opc/index"
import { PresentationError, type Deck, type ShapeNode } from "../../../core/presentation/model"
import { rebaseOdpDeck } from "../../../core/odp/write/rebase"
import { noteDiagramWritten } from "../../../core/presentation/edit/apply/smartart"
import { odpSpliceWriter } from "../../../core/odp/write/save"
import type { OdpSaveSource } from "../../../core/odp/write/splice"
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
import { bindOdpParts, odpParts } from "./open/odp"
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
	const diagrams = await insertedDiagrams(session.deck, opc, rewritten, epoch)

	rebindSources(session.deck, epoch, rewritten)

	for (const bind of diagrams) bind()

	parts.rebase(opc, contentTypes, epoch, documents, plan)

	return { ...session.package, bytes: source.size, source, archive: opc.zip, opc }
}

// Diagrams an op inserted (their parts held by the edit session, the frame with no source) that the save wrote: each
// becomes the diagram the saved slide holds, its frame naming the parts written and its source the written
// p:graphicFrame (found by its cNvPr id), so a later save edits those parts in place or leaves them, as for a diagram
// the file had, instead of adding them again. Answers the binds, run in the rebase's synchronous step.
async function insertedDiagrams(
	deck: Deck,
	opc: OpcPackage,
	rewritten: ReadonlyMap<string, { readonly from: XmlDocument; readonly to: XmlDocument }>,
	epoch: number
): Promise<(() => void)[]> {
	const binds: (() => void)[] = []

	for (const node of deck.nodes.values()) {
		const written = rewritten.get(partKey(node.part))
		const inserted: ShapeNode[] = []
		const visit = (shapes: readonly ShapeNode[], depth: number): void => {
			for (const shape of shapes) {
				if (shape.src === undefined && shape.frame?.kind === "smartart") inserted.push(shape)
				if (shape.children !== undefined && depth < 64) visit(shape.children, depth + 1)
			}
		}

		if (written === undefined) continue

		visit(node.shapes, 0)

		if (inserted.length === 0) continue

		const document = written.to
		// By its zip name, as every reader of the package asks (the parse is cached per part).
		const relationships = await opc.relationships(node.part.replace(/^\/+/u, ""))
		const frames = graphicFramesById(document)

		for (const shape of inserted) {
			const element = frames.get(String(shape.id))
			const ids = element === undefined ? undefined : diagramRelIds(document, element)
			const target = (id: string | undefined): string | undefined => {
				const name = id === undefined ? undefined : relationships.byId(id)?.partName

				return name === undefined ? undefined : `/${name.replace(/^\/+/u, "")}`
			}
			const data = target(ids?.dm)

			if (element === undefined || ids === undefined || data === undefined) continue

			const frame = {
				kind: "smartart" as const,
				data,
				layout: target(ids.lo) ?? "",
				style: target(ids.qs) ?? "",
				colors: target(ids.cs) ?? ""
			}
			const part = node.part

			binds.push(() => {
				shape.frame = frame
				shape.src = { format: "pptx", part, node: element, epoch }
				noteDiagramWritten(deck, node.ref, shape.id, frame)
			})
		}
	}

	return binds
}

// The p:graphicFrame elements of a slide by their cNvPr id.
function graphicFramesById(document: XmlDocument): Map<string, number> {
	const out = new Map<string, number>()
	const visit = (node: number, depth: number): void => {
		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "graphicFrame") {
				const nv = document.firstChildElement(child)
				const cNvPr = nv < 0 ? -1 : document.firstChildElement(nv)
				const id = cNvPr < 0 ? undefined : document.attribute(cNvPr, "id")

				if (id !== undefined && !out.has(id)) out.set(id, child)
			} else if (depth < 64) visit(child, depth + 1)
		}
	}

	visit(document.documentElement(), 0)

	return out
}

// A diagram frame's dgm:relIds relationship ids (a:graphic/a:graphicData/dgm:relIds r:dm, r:lo, r:qs, r:cs).
function diagramRelIds(document: XmlDocument, frame: number): Partial<Record<"dm" | "lo" | "qs" | "cs", string>> | undefined {
	const childNamed = (node: number, local: string): number => {
		for (let child = node < 0 ? -1 : document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
			if (document.localName(child) === local) return child

		return -1
	}
	const relIds = childNamed(childNamed(childNamed(frame, "graphic"), "graphicData"), "relIds")

	if (relIds < 0) return undefined

	const out: Partial<Record<"dm" | "lo" | "qs" | "cs", string>> = {}

	for (const attribute of document.attributes(relIds)) {
		const local = attribute.name.slice(attribute.name.indexOf(":") + 1)

		if (local === "dm" || local === "lo" || local === "qs" || local === "cs") out[local] = attribute.value
	}

	return out
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

// An ODP session onto its saved file: the saved package read again taking over the session's deck (OdpOpenOptions
// adopt), every parsed page's refs rebound into the page written for it (core/odp/write/rebase.ts).
export async function rebaseOdp(session: EngineSession, source: ByteSource): Promise<OpenedPackage> {
	const parts = odpParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "rebase without the deck's parts")

	const rebased = await rebaseOdpDeck(session.deck, parts, source)

	if ("kind" in rebased) throw new PresentationError(rebased.reason, rebased.detail ?? "rebase")

	bindOdpParts(session.deck, rebased)

	return { ...session.package, bytes: source.size, source, archive: rebased.odf.archive }
}

export function odpSaveSource(session: EngineSession): OdpSaveSource {
	const parts = odpParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "an ODP deck without its parts cannot be saved")

	return { parts }
}

export const SAVE_DEPENDENCIES: SaveDependencies = {
	savers: {
		pptx: { writer: pptxSpliceWriter, source: pptxSaveSource, seal: sealPptx },
		odp: { writer: odpSpliceWriter, source: odpSaveSource }
	},
	rebasers: { pptx: rebasePptx, odp: rebaseOdp }
}

export const saveCapability: SaveCapability = {
	save: (context, options) => saveSession(context, options, SAVE_DEPENDENCIES),
	commitSaved: (context, options) => commitSavedSession(context, options, SAVE_DEPENDENCIES)
}
