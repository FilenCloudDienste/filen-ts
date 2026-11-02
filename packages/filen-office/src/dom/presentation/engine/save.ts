import { OpcPackage, partKey, PRESENTATION_ZIP_LIMITS, type ByteSource } from "../../../core/opc/index"
import { PresentationError, type Deck, type ShapeNode } from "../../../core/presentation/model"
import { rebaseOdpDeck } from "../../../core/odp/write/rebase"
import {
	diagramDrawingRelId,
	diagramFrameWritten,
	frameInSnapshot,
	noteDiagramWritten,
	notePackageDrawingRel
} from "../../../core/presentation/edit/apply/smartart"
import { odpSpliceWriter } from "../../../core/odp/write/save"
import type { OdpSaveSource } from "../../../core/odp/write/splice"
import { checkDiagramDrawings, gateSnapshot, pptxSpliceWriter, sourceDiagramDamage } from "../../../core/pptx/write/save"
import type { PptxSpliceSource } from "../../../core/pptx/write/splice"
import type { XmlDocument } from "../../../core/xml/index"
import { bindWrittenTiming } from "../../../core/anim/prune"
import type { TimingBudgets } from "../../../core/anim/model"
import { readTiming } from "../../../core/pptx/read/timing"
import { partReader } from "../../../core/pptx/read/xml"
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
	// Parts the save left out: a source naming one (a deleted slide's, held by the history) names nothing of the file
	// written, so it is never bound to it (an undo reads that slide from the bytes it holds).
	const gone = new Set<string>()

	for (const name of saved.written) {
		const part = `/${name}`
		const from = parts.document(part)

		if (from === undefined || !opc.has(name)) {
			documents.set(part, undefined)
			// Written with no document of it to map its sources from: they stay stale too.
			gone.add(partKey(part))

			continue
		}

		const to = await opc.xml(name)

		rewritten.set(partKey(part), { from, to })
		documents.set(part, to)
	}

	for (const entry of session.package.archive?.entries ?? []) {
		if (opc.has(entry.name)) continue

		documents.set(`/${entry.name}`, undefined)
		gone.add(partKey(entry.name))
	}

	// Read before the swap, so the swap itself stays one synchronous step.
	const plan = await parts.prepareRebase(opc)
	// The edit session lets go of the held parts the bound frames named.
	const diagrams = await insertedDiagrams(
		session.deck,
		opc,
		rewritten,
		new Set([...saved.written].map(name => partKey(`/${name}`))),
		epoch,
		names => sessionEdits(session).releaseHeld(names),
		() =>
			sessionEdits(session)
				.history.steps()
				.flatMap(step => [step.op, step.inverse.ops])
	)

	rebindSources(session.deck, epoch, rewritten, gone)
	rebindTimings(session.deck, epoch, rewritten, parts.budgets.timing)

	for (const bind of diagrams) bind()

	parts.rebase(opc, contentTypes, epoch, documents, plan)

	return { ...session.package, bytes: source.size, source, archive: opc.zip, opc }
}

// A rewritten slide's timing bound node for node onto the timing the save wrote from it (rebindSources binds by path,
// which names another node once an effect moved).
function rebindTimings(
	deck: Deck,
	epoch: number,
	rewritten: ReadonlyMap<string, { readonly from: XmlDocument; readonly to: XmlDocument }>,
	budgets: TimingBudgets
): void {
	for (const node of deck.nodes.values()) {
		const src = node.src
		const timing = node.timing

		if (timing === undefined || src?.format !== "pptx") continue

		const written = rewritten.get(partKey(src.part))

		if (written === undefined) continue

		const read = readTiming({ reader: partReader(written.to), part: src.part, epoch, budgets }, written.to.documentElement())

		if (read !== undefined) bindWrittenTiming(timing, read)
	}
}

// Diagrams an op inserted (their parts held by the edit session, the frame with no source) that the save wrote: each
// becomes the diagram the saved slide holds, its frame naming the parts written and its source the written
// p:graphicFrame (found by its cNvPr id), so a later save edits those parts in place or leaves them, as for a diagram
// the file had, instead of adding them again. Answers the binds, run in the rebase's synchronous step.
async function insertedDiagrams(
	deck: Deck,
	opc: OpcPackage,
	rewritten: ReadonlyMap<string, { readonly from: XmlDocument; readonly to: XmlDocument }>,
	writtenParts: ReadonlySet<string>,
	epoch: number,
	release: (names: readonly string[]) => void,
	history: () => readonly unknown[]
): Promise<(() => void)[]> {
	const binds: (() => void)[] = []
	const held: string[] = []

	for (const node of deck.nodes.values()) {
		const written = rewritten.get(partKey(node.part))
		const slideWritten = writtenParts.has(partKey(node.part))
		const inserted: ShapeNode[] = []
		const visit = (shapes: readonly ShapeNode[], depth: number): void => {
			for (const shape of shapes) {
				// An inserted diagram, or one whose held parts this save wrote (the frame as the writer saw it: an edit
				// since makes another).
				const frame = shape.frame

				// Any other diagram of a slide the save rewrote (a copy's diagram written into parts of its own): the parts
				// its written frame names, as the snapshot saw it.
				if (
					frame?.kind === "smartart" &&
					(shape.src === undefined ||
						(heldFrame(frame) ? diagramFrameWritten(frame) : slideWritten && frameInSnapshot(deck, frame)))
				)
					inserted.push(shape)
				if (shape.children !== undefined && depth < 64) visit(shape.children, depth + 1)
			}
		}

		visit(node.shapes, 0)

		if (inserted.length === 0) continue

		// A slide the save did not rewrite (its diagram's parts written in place) as the package has it.
		const slideName = node.part.replace(/^\/+/u, "")

		if (written === undefined && !opc.has(slideName)) continue

		const document = written?.to ?? (await opc.xml(slideName))
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

			// The drawing the written data names (dsp:dataModelExt@relId, a relationship of the slide), as a read of the
			// saved file links it: an undo of a later edit holds it with the data.
			const zipData = data.slice(1)
			const relId = opc.has(zipData) ? diagramDrawingRelId(await opc.xml(zipData)) : undefined
			const drawing = target(relId)
			const frame = {
				kind: "smartart" as const,
				data,
				layout: target(ids.lo) ?? "",
				style: target(ids.qs) ?? "",
				colors: target(ids.cs) ?? "",
				...(drawing === undefined || !opc.has(drawing.slice(1)) ? {} : { drawing })
			}
			const part = node.part

			const isNew = shape.src === undefined
			const before = shape.frame

			binds.push(() => {
				shape.frame = frame

				if (relId !== undefined && frame.drawing !== undefined) notePackageDrawingRel(deck, data, relId)

				if (before?.kind === "smartart") held.push(...heldNames(before))

				if (!isNew) return

				shape.src = { format: "pptx", part, node: element, epoch }
				noteDiagramWritten(deck, node.ref, shape.id, frame)
			})
		}
	}

	// The held parts the bound frames named, let go of where no frame names them now and no step the history holds
	// does (a deleted slide's copy of the frame an undo brings back).
	if (binds.length > 0)
		binds.push(() => {
			const named = new Set<string>()

			for (const node of deck.nodes.values()) for (const name of framePartsOf(node.shapes, 0)) named.add(name)

			const loose = held.filter(name => !named.has(name))

			if (loose.length > 0) for (const name of heldNamesIn(history())) named.add(name)

			release(loose.filter(name => !named.has(name)))
		})

	return binds
}

type DiagramFrameRef = Extract<NonNullable<ShapeNode["frame"]>, { kind: "smartart" }>

function heldNames(frame: DiagramFrameRef): string[] {
	return [frame.data, frame.layout, frame.style, frame.colors, frame.drawing ?? ""].filter(name => name.startsWith("raw:"))
}

// The "raw:" names anywhere in `values` (the history's ops and inverses: frames and sources they hold).
function heldNamesIn(values: readonly unknown[]): Set<string> {
	const out = new Set<string>()
	const seen = new WeakSet<object>()
	const visit = (value: unknown, depth: number): void => {
		if (typeof value === "string") {
			if (value.startsWith("raw:")) out.add(value)

			return
		}

		if (typeof value !== "object" || value === null || depth > 256 || ArrayBuffer.isView(value) || seen.has(value)) return

		seen.add(value)

		for (const item of Array.isArray(value) ? value : value instanceof Map ? [...value.values()] : Object.values(value))
			visit(item, depth + 1)
	}

	for (const value of values) visit(value, 0)

	return out
}

function heldFrame(frame: DiagramFrameRef): boolean {
	return heldNames(frame).length > 0
}

function framePartsOf(shapes: readonly ShapeNode[], depth: number): string[] {
	const out: string[] = []

	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") out.push(...heldNames(shape.frame))
		if (shape.children !== undefined && depth < 64) out.push(...framePartsOf(shape.children, depth + 1))
	}

	return out
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
export async function rebaseOdp(session: EngineSession, source: ByteSource, saved: SavedPackage): Promise<OpenedPackage> {
	const parts = odpParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "rebase without the deck's parts")

	// Against the slides that save's own snapshot wrote (a later save may have snapshotted since).
	const rebased = await rebaseOdpDeck(session.deck, parts, source, saved.revision)

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
		pptx: {
			writer: pptxSpliceWriter,
			proof: { gate: gateSnapshot, every: checkDiagramDrawings, baseline: source => sourceDiagramDamage(source.package) },
			source: pptxSaveSource,
			seal: sealPptx
		},
		odp: { writer: odpSpliceWriter, source: odpSaveSource }
	},
	rebasers: { pptx: rebasePptx, odp: rebaseOdp }
}

export const saveCapability: SaveCapability = {
	save: (context, options) => saveSession(context, options, SAVE_DEPENDENCIES),
	commitSaved: (context, options) => commitSavedSession(context, options, SAVE_DEPENDENCIES)
}
