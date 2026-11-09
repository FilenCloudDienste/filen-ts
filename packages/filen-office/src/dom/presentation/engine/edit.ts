import { prepareOdpPictureOp } from "../../../core/odp/write/emit/picture"
import { prepareChartOp, type ChartPartSource } from "../../../core/presentation/edit/apply/chart"
import { clearDormantNotes, dormantNotesOfBody, dormantNotesOfOrigin, setDormantNotes } from "./dormantNotes"
import { notesTarget } from "../../../core/presentation/notes"
import { issuedPartNames } from "../../../core/pptx/write/parts"
import { notesBoxOf, prepareReview } from "./review"
import { proveOdpSlide } from "../../../core/odp/write/proof"
import { odpSourceReading } from "../../../core/odp/write/session"
import { odpWriteSource } from "../../../core/odp/write/source"
import { encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../../core/xml/index"
import { crc32, parseRelationships, partKey, relationshipsPartName, Relationships } from "../../../core/opc/index"
import type { PptxParts } from "../../../core/pptx/package"
import { readSlidePart } from "../../../core/pptx/read/slide"
import { G, P_MAIN, partReader } from "../../../core/pptx/read/xml"
import { sourcePictureFill } from "../../../core/pptx/write/emit/picture"
import { DeckTally } from "../../../core/presentation/budget"
import { applyAll, applyOp, opTouches, type DeckChanges, type Dirt, type Inverse, type Touch } from "../../../core/presentation/edit/apply"
import type { PictureReading } from "../../../core/presentation/edit/apply/picture"
import {
	deckDefinitionType,
	diagramPartsOf,
	diagramPicturePartsOf,
	type SmartArtSourceReading
} from "../../../core/presentation/edit/apply/smartart"
import { overlayNode, rebindEpoch, type SlideSourceReading } from "../../../core/presentation/edit/apply/slide"
import { designInfo, designLayouts, predictedSizeTouches, type DesignReading } from "../../../core/presentation/edit/apply/design"
import { inheritedDeclarations } from "../../../core/presentation/edit/canonical"
import { deckChanges, deckFingerprints, findShape, fingerprintTouches, orderKey } from "../../../core/presentation/edit/changes"
import {
	DeckHistory,
	opBytesOf,
	type HistoryStep,
	touchKey,
	UNKNOWN_FINGERPRINT,
	type Fingerprint,
	type FingerprintOf,
	type TouchKey
} from "../../../core/presentation/edit/history"
import {
	jumpsTo,
	OWNED_KINDS,
	planDelete,
	type PartOf,
	type PartReference,
	type ReferenceFacts
} from "../../../core/presentation/edit/integrity"
import type { DeckOp, RawPart } from "../../../core/presentation/edit/ops"
import { isMovable, proveSlide, type EmitFunction, type ProofTally } from "../../../core/presentation/edit/proof"
import { nextShapeId } from "../../../core/presentation/ids"
import { sliceClock, type Slicing } from "../../../core/slicing"
import {
	PresentationError,
	refused,
	slideRef,
	type Deck,
	type Refused,
	type ShapeNode,
	type ShapeRef,
	type SlideNode,
	type SlideRef,
	type SourceRef
} from "../../../core/presentation/model"
import type { TextSeed } from "../../../core/presentation/output"
import type { CallContext, EditCapability, EngineSession } from "../engine"
import type { CommandResult } from "../protocol"
import type { RefusedEdits } from "../refusedEdits"
import { bindSaveHistory, deckTurn, saveHistoryOf, type SaveHistory } from "../save"
import { odpParts } from "./open/odp"
import { pptxParts } from "./open/pptx"
import { autofitOp, textSeedOf } from "./text"
import { isRefused } from "../../../core/presentation/refusal"

// The edit capability: commands, undo and redo over the session's model, with the deck history (edit/history.ts).
// Before an op applies, every node it touches is parsed and its slide proved once (proof gate 1); the history
// records each step with what it touched before and after, so dirtiness is recomputed (edit/changes.ts). Commands
// run one at a time per session; the save capability runs its snapshot through the same queue (sessionEdits), so a
// snapshot never interleaves with an op.
//
// Source markup an inverse holds is read back as the deck's reader reads it, into documents the session keeps
// under "raw:" names: a shape's or slide's `src` names one after a save's rebase made its old ref stale.

const RAW_PREFIX = "raw:"
// The shared parts a slide delete holds for its undo: at most this share of the history's byte budget.
const SHARED_SHARE = 4
// Refs the session allocates sit above every ref the reader hands out.
const SESSION_REFS = 0x4000_0000

interface RawDocument {
	readonly document: XmlDocument
	// The part these bytes were (a slide restored from an inverse), for the writer.
	readonly part?: RawPart
	// A restored slide's: every part its restore entry held (the slide first, then its owned parts and the shared
	// ones its delete removed), for the writer to add back.
	readonly parts?: readonly RawPart[]
	// The part name the restored node has (free in the package and the session).
	readonly nodePart?: string
}

export interface EditOptions {
	// The emitters proof gate 1 checks with (emitPptx by default).
	readonly emit?: EmitFunction
}

interface EpochCache {
	readonly epoch: number
	readonly bytes: Map<string, Uint8Array>
	readonly relationships: Map<string, Relationships>
	// A slide part's root declarations, for reading held markup back when its document is not held (dropped by a
	// rebase that rewrote the part).
	readonly scopes: Map<string, string>
	facts?: Map<string, PartReference[]>
}

interface EditState {
	readonly history: DeckHistory
	readonly fingerprint: FingerprintOf
	readonly raw: Map<string, RawDocument>
	// Revisions of notes made again from dormant ones → the revision the page first saw for them (its retract names it).
	readonly origins: Map<number, number>
	// Slides proved (gate 1), with their tallies.
	readonly proved: Map<SlideRef, ProofTally>
	// Part bytes and relationships read for the current epoch (inverses and the reference graph).
	cache: EpochCache
	readonly allocatedParts: Set<string>
	// Each part's references, by its relationships part's zip entry (CRC-32 and size): a save's rebase copies the
	// entries it did not rewrite, so the graph is read again only where the save changed it.
	readonly references: Map<string, HeldReferences>
	nextRef: number
	nextRaw: number
	// Slides an undo restored onto the package's parts, with the parts their delete held and the epoch they bound to.
	readonly restored: Map<SlideRef, { readonly parts: readonly RawPart[]; epoch: number }>
}

interface HeldReferences {
	readonly crc32: number
	readonly size: number
	readonly references: PartReference[]
}

const states = new WeakMap<EngineSession, EditState>()

function partsOf(session: EngineSession): PptxParts {
	const parts = pptxParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", `editing ${session.deck.format}`)

	return parts
}

function stateOf(session: EngineSession): EditState {
	const held = states.get(session)

	if (held !== undefined) return held

	const raw = new Map<string, RawDocument>()
	const fingerprint = deckFingerprints(session.deck, src => sourceBytes(session, raw, src))
	const state: EditState = {
		history: new DeckHistory(fingerprint),
		fingerprint,
		raw,
		proved: new Map(),
		cache: { epoch: -1, bytes: new Map(), relationships: new Map(), scopes: new Map() },
		allocatedParts: new Set(),
		references: new Map(),
		nextRef: SESSION_REFS,
		nextRaw: 1,
		origins: new Map(),
		restored: new Map()
	}

	states.set(session, state)
	// A save takes back notes started and not typed in (the provisional step on top) before its snapshot, as retract()
	// would: the file never holds empty notes, and the page's open editor closes on them (the history as before them).
	// The page's editor may still be on them: they stay answered (dormant) and its first input makes them again.
	const settle = (): void => {
		// Restores this save's snapshot is about to hold are its own from here: its commit binds them.
		reconcileRestored(session, state)
		state.restored.clear()

		const step = state.history.provisionalTop()
		const revision = state.history.provisionalRevision()

		if (step === undefined || revision === undefined || step.op.family !== "notes") return

		const slide = step.op.slide
		const notes = notesTarget(session.deck, slide)
		const box = notes === undefined ? undefined : notesBoxOf(session.deck, notes)

		if (isRefused(applyAll(session.deck, step.inverse.ops, contextFor(session, state)))) return

		state.history.retract()

		if (notes !== undefined) setDormantNotes(session, { slide, op: step.op, notes, box, origin: originOf(state, revision) })

		changed(session, state, step.touches)
	}
	const saveHistory: SaveHistory = {
		get revision() {
			return state.history.revision
		},
		get dirty() {
			return state.history.dirty
		},
		get dirtyBytes() {
			return state.history.dirtyBytes
		},
		changes: () => deckChanges(session.deck, state.history, fingerprint),
		savePoint: () => state.history.savePoint(),
		commit: point => {
			state.history.commit(point)
		},
		abandon: point => {
			state.history.abandon(point)
		},
		revert: (parts, edits) => revert(session, state, parts, {}, edits),
		settle,
		steps: state.history
	}

	bindSaveHistory(session.deck, saveHistory)
	session.onClose(() => {
		const parts = pptxParts(session.deck)

		for (const name of raw.keys()) parts?.forget(name)

		raw.clear()
		state.proved.clear()
		state.cache.bytes.clear()
		state.cache.relationships.clear()
		state.references.clear()
		state.history.clear()
	})

	return state
}

// An element's bytes with the namespace declarations of its ancestors below the root added to its start tag, so a
// copy reads on its own inside a part's root scope. Most elements need none (PresentationML declares at the root).
function withAncestorDeclarations(document: XmlDocument, node: number): Uint8Array {
	const raw = document.raw(node)
	const root = document.documentElement()

	if (node === root || document.parent(node) === root) return raw

	const atRoot = inheritedDeclarations(document, document.firstChildElement(root))
	const own = new Set(document.attributes(node).map(attribute => attribute.name))
	let extra = ""

	for (const [prefix, uri] of inheritedDeclarations(document, node)) {
		const name = prefix === "" ? "xmlns" : `xmlns:${prefix}`

		if (atRoot.get(prefix) === uri || own.has(name)) continue

		extra += ` ${name}="${escapeAttribute(uri)}"`
	}

	if (extra === "") return raw

	const nameEnd = 1 + encodeUtf8(document.name(node)).length
	const head = encodeUtf8(extra)
	const out = new Uint8Array(raw.length + head.length)

	out.set(raw.subarray(0, nameEnd), 0)
	out.set(head, nameEnd)
	out.set(raw.subarray(nameEnd), nameEnd + head.length)

	return out
}

// Every branch of the outermost mc:AlternateContent holding a pptx source element, with the declarations its ancestors
// make; undefined outside one (or when the source is not at hand).
function alternateSource(session: EngineSession, raw: ReadonlyMap<string, RawDocument>, src: SourceRef): Uint8Array | undefined {
	if (src.format !== "pptx") return undefined

	const parts = pptxParts(session.deck)
	const document =
		raw.get(src.part)?.document ?? (parts !== undefined && src.epoch === parts.epoch ? parts.document(src.part) : undefined)

	if (document === undefined || src.node <= 0 || src.node >= document.count) return undefined

	const r = partReader(document)
	let unit = -1

	for (let up = document.parent(src.node); up > 0; up = document.parent(up)) {
		if (r.is(up, G.P, "spTree") || r.is(up, G.P, "grpSp")) break
		if (r.is(up, G.MC, "AlternateContent")) unit = up
	}

	return unit < 0 ? undefined : withAncestorDeclarations(document, unit)
}

function sourceBytes(session: EngineSession, raw: ReadonlyMap<string, RawDocument>, src: SourceRef): Uint8Array | Refused {
	if (src.format === "odp") {
		const odp = odpParts(session.deck)

		return odp === undefined ? refused("notImplemented", "source") : odpWriteSource(odp).sourceBytes(src)
	}

	const held = raw.get(src.part)

	if (held !== undefined) return withAncestorDeclarations(held.document, src.node)

	const parts = pptxParts(session.deck)

	if (parts === undefined) return refused("notImplemented", "source")
	if (src.epoch !== parts.epoch) return refused("stale", src.part)

	const document = parts.document(src.part)

	if (document === undefined || src.node <= 0 || src.node >= document.count) return refused("notFound", src.part)

	return withAncestorDeclarations(document, src.node)
}

function cacheOf(state: EditState, parts: PptxParts): EpochCache {
	if (state.cache.epoch !== parts.epoch)
		state.cache = { epoch: parts.epoch, bytes: new Map(), relationships: new Map(), scopes: new Map() }

	return state.cache
}

async function relationshipsOf(state: EditState, parts: PptxParts, part: string): Promise<Relationships> {
	const cache = cacheOf(state, parts)
	const key = partKey(part)
	const held = cache.relationships.get(key)

	if (held !== undefined) return held

	const relationships = parts.opc.has(part) ? await parts.opc.relationships(part.slice(1)) : new Relationships([])

	cache.relationships.set(key, relationships)

	return relationships
}

async function readBytes(state: EditState, parts: PptxParts, part: string): Promise<void> {
	const cache = cacheOf(state, parts)
	const key = partKey(part)

	if (cache.bytes.has(key) || !parts.opc.has(part)) return

	cache.bytes.set(key, parts.document(part)?.bytes ?? (await parts.opc.read(part)))
}

// A part's root declarations when its parsed document is not held (read once per epoch from its bytes).
async function scopeOf(state: EditState, parts: PptxParts, part: string): Promise<void> {
	const cache = cacheOf(state, parts)
	const key = partKey(part)

	if (parts.document(part) !== undefined || cache.scopes.has(key) || !parts.opc.has(part)) return

	cache.scopes.set(key, rootScope(parseXml(await parts.opc.read(part))))
}

function kindOf(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

function referencesOf(relationships: Relationships): PartReference[] {
	const out: PartReference[] = []

	for (const relationship of relationships.all) {
		if (relationship.external || relationship.partName === undefined) continue

		out.push({ kind: kindOf(relationship.type), part: `/${relationship.partName}` })
	}

	return out
}

const XML_PART = /\.xml$/iu

// A part's references: the ones held for its relationships entry when the entry is unchanged (same CRC-32 and size;
// an in-memory package's entries carry no CRC and are read), else read.
async function referencesFor(state: EditState, parts: PptxParts, part: string): Promise<PartReference[]> {
	const entry = parts.opc.entry(relationshipsPartName(parts.opc.entry(part)?.name ?? part.slice(1)))

	if (entry === undefined) return []

	const key = partKey(part)
	const held = state.references.get(key)

	if (held !== undefined && entry.crc32 !== 0 && held.crc32 === entry.crc32 && held.size === entry.uncompressedSize)
		return held.references

	const references = referencesOf(await relationshipsOf(state, parts, part))

	state.references.set(key, { crc32: entry.crc32, size: entry.uncompressedSize, references })

	return references
}

// Every XML part's references reachable from the presentation part, once per epoch (relationships parts a save left
// as they were are not read again), giving the host a turn whenever the slice is used up.
async function loadFacts(state: EditState, parts: PptxParts, slicing: Slicing | undefined): Promise<void> {
	const cache = cacheOf(state, parts)

	if (cache.facts !== undefined) return

	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const facts = new Map<string, PartReference[]>()
	const queue = [mainPart(parts)]
	const live = new Set<string>()

	while (queue.length > 0) {
		const part = queue.pop() as string

		if (facts.has(part) || !XML_PART.test(part)) continue
		if (clock?.due === true) await clock.pause()

		const references = await referencesFor(state, parts, part)

		facts.set(part, references)
		live.add(partKey(part))

		for (const reference of references) if (!facts.has(reference.part)) queue.push(reference.part)
	}

	// Parts gone from the package are forgotten.
	for (const key of state.references.keys()) if (!live.has(key)) state.references.delete(key)

	if (cacheOf(state, parts) === cache) cache.facts = facts
}

// The "raw:" name holding the part of a node restored from an inverse.
function rawNameOf(state: EditState, part: string): string | undefined {
	for (const [name, held] of state.raw) if ((held.nodePart ?? held.part?.name) === part) return name

	return undefined
}

function factsOf(state: EditState): ReferenceFacts {
	const facts = state.cache.facts ?? new Map<string, PartReference[]>()

	return {
		references: part => {
			const held = facts.get(part)

			if (held !== undefined) return held

			// A slide restored from an inverse refers to what its held relationships name.
			const raw = state.raw.get(rawNameOf(state, part) ?? "")?.part

			return raw?.rels === undefined ? undefined : referencesOf(parseRelationships(raw.rels, part.slice(1)))
		},
		parts: () => facts.keys()
	}
}

const MAIN_TYPE =
	/presentationml\.(?:presentation|slideshow|template)\.main\+xml$|powerpoint\.(?:presentation|slideshow|template)\.macroenabled\.main\+xml$/iu

function mainPart(parts: PptxParts): string {
	for (const entry of parts.opc.entries()) {
		const type = parts.contentTypes.typeOf(entry.name)

		if (type !== undefined && MAIN_TYPE.test(type)) return `/${entry.name}`
	}

	return "/ppt/presentation.xml"
}

// The parts a slide owns (edit/integrity.ts), depth first.
function ownedParts(facts: ReferenceFacts, part: string): string[] {
	const out: string[] = []
	const seen = new Set([part])
	const walk = (from: string, depth: number): void => {
		for (const reference of facts.references(from) ?? []) {
			if (seen.has(reference.part) || !OWNED_KINDS.has(reference.kind)) continue

			seen.add(reference.part)
			out.push(reference.part)
			if (depth < 8) walk(reference.part, depth + 1)
		}
	}

	walk(part, 0)

	return out
}

const PART_PREFIXES = {
	slide: "ppt/slides/slide",
	notesSlide: "ppt/notesSlides/notesSlide",
	theme: "ppt/theme/theme",
	slideMaster: "ppt/slideMasters/slideMaster",
	slideLayout: "ppt/slideLayouts/slideLayout"
} as const

function newPartName(state: EditState, deck: Deck, parts: PptxParts, kind: keyof typeof PART_PREFIXES): string {
	const prefix = PART_PREFIXES[kind]
	let highest = 0
	const see = (name: string): void => {
		const key = partKey(name)

		if (!key.startsWith(prefix.toLowerCase()) || !key.endsWith(".xml")) return

		const number = Number(key.slice(prefix.length, -4))

		if (Number.isInteger(number) && number > highest) highest = number
	}

	for (const entry of parts.opc.entries()) see(entry.name)
	for (const node of deck.nodes.values()) see(node.part)
	for (const name of state.allocatedParts) see(name)
	for (const name of issuedPartNames(deck)) see(name)

	const name = `/${prefix}${String(highest + 1)}.xml`

	state.allocatedParts.add(name)

	return name
}

// The declarations of a part document's root (what a held element is read inside).
function rootScope(document: XmlDocument | undefined): string {
	if (document === undefined) return ""

	let out = ""

	for (const [prefix, uri] of inheritedDeclarations(document, document.firstChildElement(document.documentElement()))) {
		if (uri === "") continue

		out += prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	return out
}

function join(...pieces: (string | Uint8Array)[]): Uint8Array {
	const chunks = pieces.map(piece => (typeof piece === "string" ? encodeUtf8(piece) : piece))
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

// A slide part (or the wrapper around a held shape) read as the pptx reader reads slides.
function readPart(parts: PptxParts, ref: SlideRef, name: string, document: XmlDocument, relationships: Relationships): SlideNode {
	return readSlidePart({
		ref,
		part: name,
		document,
		relationships,
		epoch: parts.epoch,
		// Re-read content is already in the deck's totals: a scratch tally holds it to the per-part budgets.
		tally: new DeckTally(parts.budgets),
		media: {
			contentType: part => parts.contentTypes.typeOf(part.slice(1)),
			size: part => parts.opc.entry(part)?.uncompressedSize
		},
		refOf: part => parts.refOf(part),
		themeOf: () => undefined,
		action: (reader, rels, node) => parts.action(reader, rels, node)
	}).node
}

// Held under a "raw:" name the package answers too, so the renderer and the emitters resolve its refs.
function holdRaw(state: EditState, parts: PptxParts, document: XmlDocument, held: Omit<RawDocument, "document"> = {}): string {
	const name = `${RAW_PREFIX}${String(state.nextRaw++)}`

	state.raw.set(name, { document, ...held })
	parts.adopt(name, document)

	return name
}

// A held part's name for its restored node when nothing in the package or the session has it, else a new one.
function freePartName(state: EditState, deck: Deck, parts: PptxParts, name: string, kind: keyof typeof PART_PREFIXES): string {
	const key = partKey(name)
	let taken = parts.opc.has(name) || state.allocatedParts.has(name)

	for (const node of deck.nodes.values()) if (!taken && partKey(node.part) === key) taken = true
	for (const held of state.raw.values()) if (!taken && held.nodePart !== undefined && partKey(held.nodePart) === key) taken = true

	if (taken) return newPartName(state, deck, parts, kind)

	state.allocatedParts.add(name)

	return name
}

// The package slide part whose bytes stand for a slide: its own, or for a slide an op made (a copy, read from its
// source's markup until written) its source's while that source is the current epoch's. A delete holds those bytes,
// as for any slide, so a restore after a save that dropped the source's parts reads the copy back from them.
function basePart(parts: PptxParts, slide: SlideNode): string | undefined {
	if (parts.opc.has(slide.part)) return slide.part

	const src = slide.src

	return src?.format === "pptx" && !src.part.startsWith(RAW_PREFIX) && src.epoch === parts.epoch && parts.opc.has(src.part)
		? src.part
		: undefined
}

// Relationship kinds a restored part may name outside what it held: the writer re-targets or drops slide jumps.
const RESTORE_UNCHECKED: ReadonlySet<string> = new Set(["slide"])

// A part a restored slide's restore held under its own name (a diagram part its frame names): the package lost it with
// a save after the slide's delete, and only a save after the restore writes it back. Until then it is read from here.
// Only while that held markup is still the slide's live source: once a save wrote the slide, the writer no longer adds
// the held parts back, so a name the package lacks is no live part (an undo holds its bytes again instead).
function heldRestorePart(state: EditState, deck: Deck, name: string): RawPart | undefined {
	const key = partKey(name)

	for (const [rawName, held] of state.raw) {
		if (held.parts === undefined) continue

		const part = held.parts.find(each => partKey(each.name) === key)

		if (part === undefined) continue

		for (const node of deck.nodes.values()) if (node.src?.format === "pptx" && node.src.part === rawName) return part
	}

	return undefined
}

function rawDocumentOf(state: EditState, part: string): XmlDocument | undefined {
	const name = rawNameOf(state, part)

	return name === undefined ? undefined : state.raw.get(name)?.document
}

// Slides an undo restored onto the package's parts while a save was in flight whose commit then moved the session
// onto a new file: where that file still holds their parts byte for byte they are bound to it, otherwise they read
// from the parts their delete held (as a slide restored after its delete was saved does), so they edit and save
// whole. Before every op and every save's snapshot (which then takes them over); costs nothing with no such slide.
function reconcileRestored(session: EngineSession, state: EditState): void {
	if (state.restored.size === 0 || session.deck.format === "odp") return

	const parts = pptxParts(session.deck)

	if (parts === undefined) return

	const deck = session.deck

	for (const [ref, held] of state.restored) {
		const node = deck.nodes.get(ref)

		if (node === undefined || !deck.slides.includes(ref)) {
			state.restored.delete(ref)
			continue
		}

		if (held.epoch === parts.epoch) continue

		const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)
		const same = (name: string, bytes: Uint8Array): boolean => {
			const entry = parts.opc.entry(name)

			return entry !== undefined && entry.uncompressedSize === bytes.length && entry.crc32 === crc32(bytes)
		}
		const kept = held.parts.every(
			part => same(part.name, part.bytes) && (part.rels === undefined || same(relationshipsPartName(part.name.slice(1)), part.rels))
		)

		if (kept) {
			rebindEpoch(node, parts.epoch)

			if (notes !== undefined) rebindEpoch(notes, parts.epoch)

			held.epoch = parts.epoch
			continue
		}

		const read = contextFor(session, state).readSlides(ref, held.parts)

		// Held parts that no longer read (a part they relate is gone): left bound as they are, refused when used.
		if (isRefused(read)) continue

		deck.nodes.set(ref, overlayNode(node, read[0]))

		if (notes !== undefined && read[1] !== undefined) deck.nodes.set(notes.ref, overlayNode(notes, read[1]))

		state.restored.delete(ref)
	}
}

// The engine's half of the apply context: allocators, source bytes, and reading held markup back. Synchronous: what
// it reads was prepared (prepare()).
function contextFor(
	session: EngineSession,
	state: EditState
): SlideSourceReading & Partial<PictureReading & SmartArtSourceReading & DesignReading> {
	if (session.deck.format === "odp") {
		const odp = odpParts(session.deck)

		if (odp === undefined) throw new PresentationError("notImplemented", "editing odp")

		return odpSourceReading(session.deck, odpWriteSource(odp), { next: () => slideRef(state.nextRef++) })
	}

	const parts = partsOf(session)
	const deck = session.deck
	const facts = factsOf(state)
	const cache = cacheOf(state, parts)
	const readHeld = (part: RawPart, ref: SlideRef, name: string, all?: readonly RawPart[]): SlideNode | Refused => {
		let document: XmlDocument

		try {
			document = parseXml(part.bytes)
		} catch {
			return refused("malformed", part.name)
		}

		const relationships = part.rels === undefined ? new Relationships([]) : parseRelationships(part.rels, part.name.slice(1))
		const node = readPart(
			parts,
			ref,
			holdRaw(state, parts, document, { part, nodePart: name, ...(all === undefined ? {} : { parts: all }) }),
			document,
			relationships
		)

		// The node has a part of its own again (the writer adds it there); its sources are the held document.
		node.part = name

		return node
	}

	const reading: SlideSourceReading & PictureReading & SmartArtSourceReading & DesignReading = {
		sourceBytes: src => sourceBytes(session, state.raw, src),
		keptSource: shape => (shape.src === undefined ? undefined : alternateSource(session, state.raw, shape.src)),
		epoch: parts.epoch,
		restoredLive: (ref, held) => {
			state.restored.set(ref, { parts: held, epoch: parts.epoch })
		},
		newShapeId: slide => nextShapeId(deck.nodes.get(slide)?.shapes ?? []),
		newSlideRef: () => slideRef(state.nextRef++),
		movable: shape => isMovable(shape, part => parts.document(part) ?? state.raw.get(part)?.document),
		readShape(slide, raw) {
			const held = parts.document(slide.part) ?? rawDocumentOf(state, slide.part)
			const scope = held === undefined ? (cache.scopes.get(partKey(slide.part)) ?? "") : rootScope(held)
			const relationships = cache.relationships.get(partKey(slide.part)) ?? new Relationships([])
			let document: XmlDocument

			try {
				document = parseXml(
					join(
						`<w:sld xmlns:w="${P_MAIN}"${scope}><w:cSld><w:spTree><w:nvGrpSpPr><w:cNvPr id="0" name=""/><w:cNvGrpSpPr/><w:nvPr/></w:nvGrpSpPr><w:grpSpPr/>`,
						raw,
						"</w:spTree></w:cSld></w:sld>"
					)
				)
			} catch {
				return refused("malformed", "held shape markup")
			}

			const shape = readPart(parts, slide.ref, holdRaw(state, parts, document), document, relationships).shapes[0]

			return shape === undefined ? refused("malformed", "held shape markup") : shape
		},
		rawParts(slide, removed) {
			// A held list stands for the slide only while its held document is the node's live source: once a save wrote
			// the slide and the rebase moved its source into the package, the package's parts are the slide's.
			const held = slide.src?.format === "pptx" ? state.raw.get(slide.src.part) : undefined

			if (held?.part !== undefined) return held.parts ?? [held.part]

			const base = basePart(parts, slide)

			if (base === undefined) return []

			const out: RawPart[] = []
			const hold = (name: string): void => {
				const bytes = cache.bytes.get(partKey(name)) as Uint8Array
				const rels = cache.bytes.get(partKey(relationshipsPartName(name)))
				// Targets the package lacks already (a damaged source): restored as they were, never as new damage.
				const absent = (facts.references(name) ?? [])
					.filter(reference => !parts.opc.has(reference.part))
					.map(reference => reference.part)

				out.push({
					name,
					contentType: parts.contentTypes.typeOf(name.slice(1)) ?? "application/xml",
					bytes,
					...(rels === undefined ? {} : { rels }),
					...(absent.length === 0 ? {} : { absent })
				})
			}
			// An owned part the package does not have (the source's relationship already dangles) has nothing to hold.
			const own = [base, ...ownedParts(facts, base).filter(name => parts.opc.has(name))]

			for (const name of own) {
				if (!cache.bytes.has(partKey(name))) return refused("notFound", `part ${name} not read`)

				hold(name)
			}

			if (removed === undefined) return out

			// Shared parts the delete removes (read when they fit the budget): after its save they are gone.
			const named = new Set(own.map(partKey))

			for (const from of own) {
				for (const reference of facts.references(from) ?? []) {
					const key = partKey(reference.part)

					if (named.has(key) || !removed.has(reference.part) || !cache.bytes.has(key)) continue

					named.add(key)
					hold(reference.part)
				}
			}

			return out
		},
		readSlides(ref, held) {
			const slidePart = held[0]

			if (slidePart === undefined) return refused("malformed", "a restore without its slide part")

			// Every part a held one relates to is held or still in the package (a shared part too large to hold is
			// gone once the delete was saved): the slide comes back whole or not at all.
			const names = new Set(held.map(part => partKey(part.name)))
			const references = new Map<string, PartReference[]>()

			for (const part of held) {
				const list = part.rels === undefined ? [] : referencesOf(parseRelationships(part.rels, part.name.slice(1)))

				references.set(part.name, list)

				for (const reference of list) {
					if (
						RESTORE_UNCHECKED.has(reference.kind) ||
						names.has(partKey(reference.part)) ||
						parts.opc.has(reference.part) ||
						part.absent?.includes(reference.part) === true
					)
						continue

					return refused("stale", `${reference.part} of the deleted slide is no longer held`)
				}
			}

			const slide = readHeld(slidePart, ref, freePartName(state, deck, parts, slidePart.name, "slide"), held)

			if (isRefused(slide)) return slide

			const notesTarget = (references.get(slidePart.name) ?? []).find(reference => reference.kind === "notesSlide")
			const notesPart = notesTarget === undefined ? undefined : held.find(part => part.name === notesTarget.part)

			if (notesPart === undefined) return [slide]

			const notes = readHeld(notesPart, slideRef(state.nextRef++), freePartName(state, deck, parts, notesPart.name, "notesSlide"))

			if (isRefused(notes)) return notes

			slide.notes = notes.ref

			return [slide, notes]
		},
		newPart: kind => newPartName(state, deck, parts, kind),
		partFree: (name, ref) => {
			const key = partKey(name)

			if (parts.opc.has(name) && parts.refOf(name) !== ref) return false

			for (const node of deck.nodes.values()) if (partKey(node.part) === key) return false

			return true
		},
		facts,
		partOf: partOf(deck, parts),
		pictureFill(slide, shape) {
			if (shape.src?.format !== "pptx") return undefined

			const document = parts.document(shape.src.part) ?? state.raw.get(shape.src.part)?.document

			if (document === undefined) return refused("stale", "the picture's source is not held")

			return sourcePictureFill(document, shape, cache.relationships.get(partKey(slide.part)) ?? new Relationships([]), parts.tally)
		},
		// A diagram part prepare read (one the package no longer has is no part to name), or one an op held.
		diagramDocument: part =>
			part.startsWith(RAW_PREFIX)
				? state.raw.get(part)?.document
				: parts.opc.has(part) || heldRestorePart(state, deck, part) !== undefined
					? parts.document(part)
					: undefined,
		holdDiagram: (document, name) => {
			// An undo holds a part again under the name it had, so the frame reads as it did.
			if (name === undefined || !name.startsWith(RAW_PREFIX) || state.raw.has(name)) return holdRaw(state, parts, document)

			state.raw.set(name, { document })
			parts.adopt(name, document)

			return name
		},
		releaseDiagram: name => {
			const held = state.raw.get(name)

			// Only a part an op held (no restored slide's markup, which the writer reads by name).
			if (held === undefined || held.part !== undefined || held.parts !== undefined || held.nodePart !== undefined) return

			state.raw.delete(name)
			parts.forget(name)
		},
		partsOfType: type => diagramPartsOfType(parts, type),
		diagramRelationshipTarget: (part, id) => {
			const relationship = cache.relationships.get(partKey(part))?.byId(id)

			return relationship === undefined || relationship.external || relationship.partName === undefined
				? undefined
				: `/${relationship.partName}`
		},
		// A design op's generated parts, held under their part names (the renderer and the writer resolve them).
		holdDesign(part, ref) {
			let document: XmlDocument

			try {
				document = parseXml(part.bytes)
			} catch {
				return refused("malformed", part.name)
			}

			if (part.kind === "theme") {
				parts.adoptTheme(part.name, document)

				return undefined
			}

			parts.adopt(part.name, document)

			const relationships = part.rels === undefined ? new Relationships([]) : parseRelationships(part.rels, part.name.slice(1))

			return readPart(parts, ref ?? slideRef(state.nextRef++), part.name, document, relationships)
		},
		newDesignPart: kind => newPartName(state, deck, parts, kind)
	}

	return reading
}

// The package's parts of a content type ("/ppt/diagrams/layout1.xml"…), in package order.
function diagramPartsOfType(parts: PptxParts, type: string): string[] {
	const out: string[] = []

	for (const entry of parts.opc.entries()) if (parts.contentTypes.typeOf(entry.name) === type) out.push(`/${entry.name}`)

	return out
}

function partOf(deck: Deck, parts: PptxParts): PartOf {
	return ref => parts.partOf(ref) ?? deck.nodes.get(ref)?.part
}

function slidesOf(touches: readonly Touch[]): Set<SlideRef> {
	const out = new Set<SlideRef>()

	for (const touch of touches) if (touch.kind === "shape" || touch.kind === "slide") out.add(touch.slide)

	return out
}

async function prove(session: EngineSession, state: EditState, node: SlideNode, options: EditOptions): Promise<void> {
	if (state.proved.has(node.ref) || node.kind !== "slide") return

	const parts = partsOf(session)
	const document = parts.document(node.part)

	if (document === undefined) return

	const lockedBefore = new Set<ShapeNode>()
	const collect = (shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.lock !== undefined) lockedBefore.add(shape)
			if (shape.children !== undefined) collect(shape.children)
		}
	}

	collect(node.shapes)
	state.proved.set(
		node.ref,
		proveSlide({
			deck: session.deck,
			slide: node,
			document,
			relationships: await relationshipsOf(state, parts, node.part),
			// Shapes changed since the last save (made while a save wrote the slide, an undo or redo since): their model is
			// not their source's, so gate 1 does not prove them against it.
			edited: new Set(saveHistoryOf(session.deck)?.changes().parts.get(node.part)?.shapes.keys() ?? []),
			...(options.emit === undefined ? {} : { emit: options.emit })
		})
	)

	const notify = (shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.lock === "proofFailed" && !lockedBefore.has(shape)) {
				session.emit({ type: "notice", notice: { kind: "lock", shape: { slide: node.ref, id: shape.id }, reason: "proofFailed" } })
			}

			if (shape.children !== undefined) notify(shape.children)
		}
	}

	notify(node.shapes)
}

// What of a page an op may change without writing its shapes again: its transition, its background, its own
// attributes (hidden, name).
const AROUND_SHAPES: ReadonlySet<string> = new Set(["transition", "background", "attributes", "notes", "comments"])

// The pages an op changes only around their shapes (every touch of theirs one of AROUND_SHAPES): their shapes are
// written as they are, so they need no proof yet. A theme or size change and the slide ops rewrite shapes: none.
function aroundShapesOnly(op: DeckOp, touches: readonly Touch[]): Set<SlideRef> {
	const out = new Set<SlideRef>()
	const ops = op.family === "batch" ? op.ops : [op]

	if (ops.some(each => each.family === "slide" || (each.family === "design" && each.kind !== "setBackground"))) return out

	const rewritten = new Set<SlideRef>()

	for (const touch of touches) {
		if (touch.kind === "shape") rewritten.add(touch.slide)
		else if (touch.kind === "slide") {
			if (touch.dirt.kind === "slidePart" && AROUND_SHAPES.has(touch.dirt.part)) out.add(touch.slide)
			else rewritten.add(touch.slide)
		}
	}

	for (const ref of rewritten) out.delete(ref)

	return out
}

// An ODP op's slides parsed and proved (core/odp/write/proof.ts); a delete also parses the pages that link to the
// deleted ones by name, so their jumps are rewritten. ODF has no relationships: no reference graph to load.
async function prepareOdp(
	session: EngineSession,
	state: EditState,
	op: DeckOp,
	slicing: CallContext["slicing"] | undefined
): Promise<void> {
	const parts = odpParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "editing odp")

	const deck = session.deck
	const source = odpWriteSource(parts)
	const touches = opTouches(op)
	const slides = slidesOf(touches)
	const unproved = aroundShapesOnly(op, touches)

	// A theme or size change judges every slide (its master, its shapes): all parsed first.
	if (op.family === "design" && (op.kind !== "setBackground" || op.slides === "all")) for (const ref of deck.slides) slides.add(ref)

	if (op.family === "slide") {
		if (op.kind === "delete" || op.kind === "hide" || op.kind === "move") for (const ref of op.slides) slides.add(ref)
		if (op.kind === "duplicate" || op.kind === "setLayout" || op.kind === "reset") slides.add(op.slide)
		if (op.kind === "delete") for (const ref of await source.linkingTo(op.slides, deck)) slides.add(ref)
	}

	for (const ref of slides) {
		if (!deck.nodes.has(ref) && !deck.slides.includes(ref)) continue

		const node = await parts.slide(ref, slicing)

		// A page the op changes only around its shapes is proved when an op first rewrites them.
		if (state.proved.has(ref) || node.kind !== "slide" || unproved.has(ref)) continue

		const lockedBefore = new Set<ShapeNode>()
		const collect = (shapes: readonly ShapeNode[]): void => {
			for (const shape of shapes) {
				if (shape.lock !== undefined) lockedBefore.add(shape)
				if (shape.children !== undefined) collect(shape.children)
			}
		}
		const notify = (shapes: readonly ShapeNode[]): void => {
			for (const shape of shapes) {
				if (shape.lock === "proofFailed" && !lockedBefore.has(shape))
					session.emit({
						type: "notice",
						notice: { kind: "lock", shape: { slide: node.ref, id: shape.id }, reason: "proofFailed" }
					})
				if (shape.children !== undefined) notify(shape.children)
			}
		}

		collect(node.shapes)
		state.proved.set(ref, proveOdpSlide({ deck, slide: node, source }))
		notify(node.shapes)
	}

	// A crop of a source picture is written in lengths of its image's own size: read from the entry's header.
	await prepareOdpPictureOp(deck, op, parts.opc, slicing)
	// A chart op's chart object, its own table, a new workbook's cells (apply/chart.ts).
	await prepareChartOp(deck, op, { opc: parts.opc, document: part => parts.document(part) }, slicing)
}

// Everything an op needs before it applies: its slides parsed and proved, their relationships, and for the
// structure ops the reference graph, the slides that jump to a deleted one, and the parts an inverse holds.
async function prepare(
	session: EngineSession,
	state: EditState,
	op: DeckOp,
	slicing: CallContext["slicing"] | undefined,
	options: EditOptions
): Promise<void> {
	reconcileRestored(session, state)

	// A batch's ops each, before any applies (they name what the deck has now).
	if (op.family === "batch") {
		for (const each of op.ops) await prepare(session, state, each, slicing, options)

		return
	}

	// A notes or comment op's slide, its comments and the deck's comment facts.
	await prepareReview(session, op, slicing)

	if (session.deck.format === "odp") return prepareOdp(session, state, op, slicing)

	const parts = partsOf(session)
	const deck = session.deck
	// Only a listed slide is read from the package (a deleted one's ref may still name its old part).
	const parse = async (ref: SlideRef): Promise<SlideNode | undefined> => {
		const held = deck.nodes.get(ref)

		if (held !== undefined) return held
		if (!deck.slides.includes(ref) || parts.partOf(ref) === undefined) return undefined

		return parts.slide(ref, slicing)
	}
	const slides = slidesOf(opTouches(op))

	// A theme or size change judges every slide (its master, its shapes): all parsed first.
	if (op.family === "design" && (op.kind !== "setBackground" || op.slides === "all")) for (const ref of deck.slides) slides.add(ref)

	if (op.family === "slide") {
		if (op.kind === "delete" || op.kind === "hide" || op.kind === "move") for (const ref of op.slides) slides.add(ref)
		if (op.kind === "duplicate" || op.kind === "setLayout" || op.kind === "reset") slides.add(op.slide)
	}

	for (const ref of slides) {
		const node = await parse(ref)

		if (node === undefined) continue

		await relationshipsOf(state, parts, node.part)
		await scopeOf(state, parts, node.part)
		// A transition op writes no shape (the slide's p:transition only, emit/transition.ts), so its slides need no
		// shape proof; an op that writes shapes on them proves them when it comes.
		if (op.family !== "transition" && op.family !== "comment" && op.family !== "notes") await prove(session, state, node, options)
	}

	// A duplicate's source notes, read: the copy's notes are a copy of the model's (or none), never decided later from
	// the package (where an undo since the last save may have left notes the source no longer has).
	if (op.family === "slide" && op.kind === "duplicate") {
		const notes = deck.nodes.get(op.slide)?.notes

		if (notes !== undefined && !deck.nodes.has(notes)) await parts.slide(notes, slicing)
	}

	// The diagram parts a smartart op reads (apply/smartart.ts), parsed beside the package's other documents; one past
	// the XML part budget is not read (the op is refused).
	const definitionType = deckDefinitionType(op)

	for (const part of [...diagramPartsOf(deck, op), ...(definitionType === undefined ? [] : diagramPartsOfType(parts, definitionType))]) {
		if (part.startsWith(RAW_PREFIX) || parts.document(part) !== undefined) continue

		if (!parts.opc.has(part)) {
			// A restored slide's frame names the diagram parts its restore held (no save since wrote them back).
			const held = heldRestorePart(state, deck, part)

			if (held === undefined) continue
			if (held.bytes.length > parts.budgets.xmlPartBytes) throw new PresentationError("tooLarge", `diagram part ${part}`)

			let document: XmlDocument

			try {
				document = parseXml(held.bytes)
			} catch {
				// Held markup that does not read: the file's fault, refused as such (never as a missing part).
				throw new PresentationError("malformed", `diagram part ${part}`)
			}

			parts.adopt(part, document)

			continue
		}

		if ((parts.opc.entry(part)?.uncompressedSize ?? 0) > parts.budgets.xmlPartBytes) continue

		parts.adopt(part, await parts.opc.xml(part))
	}

	// A picture put into a diagram whose data holds pictures of its own: that data part's relationships name them.
	for (const part of diagramPicturePartsOf(deck, op)) await relationshipsOf(state, parts, part)

	// A chart op's chart part, its embedded workbook, a new workbook's cells, an inserted chart's workbook.
	await prepareChartOp(deck, op, chartPartSource(session, parts), slicing)

	if (op.family !== "slide" || !(op.kind === "delete" || op.kind === "restore" || op.kind === "duplicate")) return

	await loadFacts(state, parts, slicing)

	const facts = factsOf(state)
	const graph = cacheOf(state, parts).facts ?? new Map<string, PartReference[]>()
	const read = async (part: string): Promise<void> => {
		await readBytes(state, parts, part)
		await readBytes(state, parts, relationshipsPartName(part))
	}

	if (op.kind === "restore") {
		for (const entry of op.slides) for (const part of entry.parts) await read(part.name)

		return
	}

	if (op.kind === "duplicate") return

	const named = op.slides.map(ref => {
		const node = deck.nodes.get(ref)

		return node === undefined ? parts.partOf(ref) : (basePart(parts, node) ?? node.part)
	})

	for (const name of named) if (name !== undefined) for (const part of [name, ...ownedParts(facts, name)]) await read(part)

	// Slides jumping to a deleted one are parsed and proved, so their jumps are rewritten (or the delete refused
	// on a locked shape).
	const targets = new Set(named)
	const gone = new Set(op.slides)

	for (const ref of deck.slides) {
		const part = parts.partOf(ref)

		if (part === undefined || deck.nodes.has(ref) || gone.has(ref)) continue
		if ((graph.get(part) ?? []).some(reference => reference.kind === "slide" && targets.has(reference.part))) await parse(ref)
	}

	for (const { site } of jumpsTo(deck, gone)) {
		const node = deck.nodes.get(site.shape.slide)

		if (node === undefined) continue

		await relationshipsOf(state, parts, node.part)
		await scopeOf(state, parts, node.part)
		await prove(session, state, node, options)
	}

	// The shared parts the delete removes (a picture only these slides show) are held with it, within a budget: an
	// undo after the save that removed them puts them back. Past the budget the undo is refused once they are gone.
	const own = new Set<string>()

	for (const name of named) if (name !== undefined) for (const part of [name, ...ownedParts(facts, name)]) own.add(part)

	const shared = planDelete(deck, op.slides, facts, partOf(deck, parts)).remove.filter(part => !own.has(part))
	let size = 0

	for (const part of shared) size += parts.opc.entry(part)?.uncompressedSize ?? 0

	if (size <= state.history.limits.maxBytes / SHARED_SHARE) for (const part of shared) await read(part)
}

function unique(touches: readonly Touch[]): Touch[] {
	return [...new Map(touches.map(touch => [touchKey(touch), touch])).values()]
}

// What an op will touch, as far as the model tells before it applies: its own touches and the shapes and notes
// its inverse will name (the children of a group, a deleted slide's notes, the placeholders a reset or a layout
// change rewrites).
function predictedTouches(deck: Deck, op: DeckOp): Touch[] {
	if (op.family === "batch") return op.ops.flatMap(each => predictedTouches(deck, each))

	const out = [...opTouches(op)]

	if (op.family === "shape" && (op.kind === "ungroup" || op.kind === "group")) {
		const node = deck.nodes.get(op.slide)
		const ids =
			op.kind === "ungroup" ? (findShape(node?.shapes ?? [], op.group)?.shape.children ?? []).map(child => child.id) : op.shapes

		for (const id of ids) out.push({ kind: "shape", slide: op.slide, shape: id, dirt: { kind: "node" } })
	}

	// A content op on a shape backed by source is undone by replacing the shape (its node).
	if (op.family === "shape" && (op.kind === "setProps" || op.kind === "setStyle" || op.kind === "setAlt" || op.kind === "setAction")) {
		out.push({ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } })
	}

	if (op.family === "slide" && op.kind === "delete") {
		for (const ref of op.slides) {
			const notes = deck.nodes.get(ref)?.notes

			if (notes !== undefined) out.push({ kind: "slide", slide: notes, dirt: { kind: "node" } })
		}

		for (const { site } of jumpsTo(deck, new Set(op.slides))) {
			out.push({
				kind: "shape",
				slide: site.shape.slide,
				shape: site.shape.id,
				dirt: site.kind === "shape" || site.cell !== undefined ? { kind: "node" } : { kind: "text" }
			})
		}
	}

	out.push(...predictedSizeTouches(deck, op))

	if (op.family === "slide" && (op.kind === "reset" || op.kind === "setLayout")) {
		for (const shape of deck.nodes.get(op.slide)?.shapes ?? []) {
			if (shape.ph === undefined) continue

			const target = { kind: "shape", slide: op.slide, shape: shape.id } as const

			out.push({ ...target, dirt: { kind: "xfrm" } }, { ...target, dirt: { kind: "node" } })

			for (const group of ["geometry", "fill", "ln", "effects", "bodyPr"] as const)
				out.push({ ...target, dirt: { kind: "props", group } })
		}
	}

	return out
}

const ABSENT_BEFORE: Fingerprint = { digest: "", exists: false }

const SHAPE_DIRTS: readonly Dirt[] = [
	{ kind: "node" },
	{ kind: "xfrm" },
	{ kind: "text" },
	...(["geometry", "fill", "ln", "effects", "bodyPr", "style"] as const).map(group => ({ kind: "props", group }) as const)
]
const SLIDE_PART_DIRTS: readonly Dirt[] = (
	["background", "timing", "transition", "hf", "clrMapOvr", "attributes", "notes", "comments"] as const
).map(part => ({ kind: "slidePart", part }) as const)

// A whole node stands for every key under it (a shape's xfrm, groups and text; a slide's parts and every shape on
// it), so a step replacing or removing a node records what each of them was and became.
function expandTouches(deck: Deck, touches: readonly Touch[]): Touch[] {
	const out: Touch[] = [...touches]
	const shapeKeys = (slide: SlideRef, shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			for (const dirt of SHAPE_DIRTS) out.push({ kind: "shape", slide, shape: shape.id, dirt })
			if (shape.children !== undefined) shapeKeys(slide, shape.children)
		}
	}

	for (const touch of touches) {
		if ((touch.kind !== "shape" && touch.kind !== "slide") || touch.dirt.kind !== "node") continue

		if (touch.kind === "shape") {
			for (const dirt of SHAPE_DIRTS) out.push({ kind: "shape", slide: touch.slide, shape: touch.shape, dirt })

			const children = findShape(deck.nodes.get(touch.slide)?.shapes ?? [], touch.shape)?.shape.children

			if (children !== undefined) shapeKeys(touch.slide, children)
		} else {
			for (const dirt of SLIDE_PART_DIRTS) out.push({ kind: "slide", slide: touch.slide, dirt })

			shapeKeys(touch.slide, deck.nodes.get(touch.slide)?.shapes ?? [])
		}
	}

	return unique(out)
}

// The sibling-order keys of every parent (the tree and each group) on the slides a whole node of `touches` is on.
function orderKeys(deck: Deck, touches: readonly Touch[]): TouchKey[] {
	const slides = new Set<SlideRef>()

	for (const touch of touches)
		if ((touch.kind === "shape" || touch.kind === "slide") && touch.dirt.kind === "node") slides.add(touch.slide)

	const out: TouchKey[] = []
	const groups = (slide: SlideRef, shapes: readonly ShapeNode[]): void => {
		for (const shape of shapes) {
			if (shape.kind !== "grpSp") continue

			out.push(orderKey(slide, shape.id))
			groups(slide, shape.children ?? [])
		}
	}

	for (const slide of slides) {
		const node = deck.nodes.get(slide)

		if (node === undefined) continue

		out.push(orderKey(slide, 0))
		groups(slide, node.shapes)
	}

	return out
}

// Whether a key lies under a node one of `touches` names.
function coveredBy(key: TouchKey, touches: readonly Touch[]): boolean {
	return touches.some(touch => {
		if (touch.kind === "shape" && touch.dirt.kind === "node") return key.startsWith(`s:${String(touch.slide)}:${String(touch.shape)}:`)
		if (touch.kind === "slide" && touch.dirt.kind === "node")
			return key.startsWith(`s:${String(touch.slide)}:`) || key.startsWith(`n:${String(touch.slide)}:`)

		return false
	})
}

// What an op made, once applied: the touches its applied form names that its request did not (an allocated shape
// id, a new slide ref) and a new slide's notes.
function madeTouches(deck: Deck, requested: DeckOp, applied: DeckOp): Touch[] {
	if (requested.family === "batch" && applied.family === "batch")
		return applied.ops.flatMap((each, index) => madeTouches(deck, requested.ops[index] ?? each, each))

	const asked = new Set(opTouches(requested).map(touchKey))
	const out = opTouches(applied).filter(touch => !asked.has(touchKey(touch)))

	if (applied.family === "slide" && (applied.kind === "add" || applied.kind === "duplicate") && applied.ref !== undefined) {
		const notes = deck.nodes.get(applied.ref)?.notes

		if (notes !== undefined) out.push({ kind: "slide", slide: notes, dirt: { kind: "node" } })
	}

	return out
}

function burstOf(op: DeckOp): string | undefined {
	// A typed body with the box its autofit sized (autofitOp): the burst of its text.
	if (op.family === "batch") {
		const [text, box] = op.ops

		return op.ops.length === 2 &&
			text?.family === "text" &&
			text.kind === "setText" &&
			box?.family === "shape" &&
			box.kind === "setXfrm" &&
			box.target.slide === text.target.slide &&
			box.target.id === text.target.id
			? burstOf(text)
			: undefined
	}

	if (op.family === "text" && op.kind === "setText" && op.burst !== undefined) {
		return `text:${String(op.target.slide)}:${String(op.target.id)}:${String(op.burst)}`
	}

	if (op.family === "table" && op.kind === "setCellText" && op.burst !== undefined) {
		return `cell:${String(op.target.slide)}:${String(op.target.id)}:${String(op.row)}:${String(op.col)}:${String(op.burst)}`
	}

	return undefined
}

function changed(session: EngineSession, state: EditState, touches: readonly Touch[]): void {
	const deck = session.deck
	// The slide list (its order, and each slide's hidden flag) and the sections, re-sent when an op changed them.
	const listChanged = touches.some(
		touch =>
			(touch.kind === "presentation" && (touch.what === "slideList" || touch.what === "sections")) ||
			(touch.kind === "slide" && touch.dirt.kind === "slidePart" && touch.dirt.part === "attributes")
	)
	const showChanged = touches.some(touch => touch.kind === "presentation" && touch.what === "show")
	// A design op: the slide size, or masters and layouts added or dropped (node touches on nodes no slide list holds).
	const designChanged = touches.some(
		touch =>
			(touch.kind === "presentation" && touch.what === "size") ||
			(touch.kind === "slide" &&
				touch.dirt.kind === "node" &&
				(deck.masters.includes(touch.slide) || deck.layouts.includes(touch.slide) || !deck.nodes.has(touch.slide)))
	)

	session.emit({
		type: "changed",
		revision: state.history.revision,
		dirty: state.history.dirty,
		dirtyBytes: state.history.dirtyBytes,
		canUndo: state.history.canUndo,
		canRedo: state.history.canRedo,
		slides: [...slidesOf(touches)].filter(ref => deck.slides.includes(ref)),
		...(listChanged || showChanged || designChanged
			? {
					info: {
						...(listChanged
							? {
									slides: deck.slides.map(ref => ({
										ref,
										hidden: deck.nodes.get(ref)?.hidden ?? deck.hiddenSlides?.has(ref) ?? false
									})),
									sections: deck.sections
								}
							: {}),
						...(showChanged ? { show: deck.show } : {}),
						...(designChanged
							? {
									size: { ...deck.size },
									layouts: designLayouts(deck),
									design: designInfo(deck, part => pptxParts(deck)?.theme(part))
								}
							: {})
					}
				}
			: {})
	})
}

// A slide delete turned jumps to the deleted slides into "next slide": the page is told (its inverse holds them).
function reportJumps(session: EngineSession, op: DeckOp, inverse: Inverse): void {
	if (op.family !== "slide" || op.kind !== "delete") return

	const jumps = inverse.ops.flatMap(back =>
		back.family === "slide" && back.kind === "restore" ? back.slides.flatMap(entry => entry.jumps ?? []) : []
	)

	if (jumps.length === 0) return

	const shapes = new Map<string, ShapeRef>()

	for (const { site } of jumps) shapes.set(`${String(site.shape.slide)}:${String(site.shape.id)}`, site.shape)

	session.emit({ type: "notice", notice: { kind: "jumpsRewritten", count: jumps.length, shapes: [...shapes.values()] } })
}

// The open body laid out again when the step touched its shape; none while the text capability is not built.
async function seedFor(context: CallContext, open: ShapeRef | undefined, touches: readonly Touch[]): Promise<TextSeed | undefined> {
	if (open === undefined || !touches.some(touch => touch.kind === "shape" && touch.slide === open.slide && touch.shape === open.id))
		return undefined
	// The step took the open body away (an undo of notes made with their text): nothing to seed, and nothing refused.
	if (!context.session.deck.nodes.has(open.slide)) return undefined

	try {
		// The seed itself (in this turn already: the capability's would wait on it to make dormant notes again).
		return await textSeedOf(context, open)
	} catch (error) {
		if (error instanceof PresentationError && error.reason === "notImplemented") return undefined

		throw error
	}
}

// Runs in the deck's turn: commands, undo, redo and a save's snapshot never interleave.
function serial<T>(session: EngineSession, task: () => Promise<T>): Promise<T> {
	return deckTurn(session.deck, task)
}

function refusal(error: unknown): CommandResult {
	if (error instanceof PresentationError) return { ok: false, refusal: error.reason }

	throw error
}

// The history's accounting of a step: its op, its inverse's typed values and bytes, and the fingerprints it keeps.
function inverseWithBytes(inverse: Inverse): Inverse {
	let bytes = 0

	for (const op of inverse.ops) bytes += opBytesOf(op)

	return { ops: inverse.ops, bytes }
}

// Heap estimates (V8, measured on 60-step histories): a map entry with its fingerprint object, and a touch.
const FINGERPRINT_ENTRY = 400
const TOUCH_BYTES = 256

function fingerprintBytes(map: ReadonlyMap<TouchKey, Fingerprint>): number {
	let bytes = 0

	for (const [key, value] of map) bytes += FINGERPRINT_ENTRY + 2 * (key.length + value.digest.length) + 8 * (value.order?.length ?? 0)

	return bytes
}

// `open`: the body open in the text editor view, answered as a seed when the step touched it.
async function command(context: CallContext, op: DeckOp, options: EditOptions, open?: ShapeRef): Promise<CommandResult> {
	const session = context.session
	const state = stateOf(session)

	return serial(session, async () => {
		if (session.deck.gate.length > 0) return { ok: false, refusal: "viewOnly" }

		await reviveFor(session, state, op, context.slicing, options)

		const revision = state.history.revision
		const base = session.package
		// A body PowerPoint autofits takes the fit of its new text in the same step.
		const fitted = await autofitOp(session, op, context.slicing)
		const first = await applyStep(session, state, fitted, context.slicing, options)
		// A save's commit moved the session onto the file it made while the op was read against the old one (its reads
		// wait for the commit, then miss parts the save rewrote; what it read is the old package's): refused, nothing
		// changed, so the op once more against the file as it is now.
		const result = !first.ok && session.package !== base ? await applyStep(session, state, fitted, context.slicing, options) : first

		if (!result.ok || open === undefined || state.history.revision === revision) return result

		const seed = await seedFor(context, open, state.history.peekUndo()?.touches ?? [])

		return seed === undefined ? result : { ...result, seed }
	})
}

// The revision a page first saw for a step: notes made again from dormant ones keep their first one.
function originOf(state: EditState, revision: number): number {
	return state.origins.get(revision) ?? revision
}

// Makes dormant notes again (the same op: the same refs and part) when an op names their body, before it applies:
// as one provisional step, so the text that follows continues it.
async function reviveFor(
	session: EngineSession,
	state: EditState,
	op: DeckOp,
	slicing: CallContext["slicing"] | undefined,
	options: EditOptions
): Promise<void> {
	const named = "target" in op && typeof op.target === "object" ? (op.target as { readonly slide?: SlideRef }).slide : undefined

	if (named !== undefined) await revive(session, state, named, slicing, options)
}

async function revive(
	session: EngineSession,
	state: EditState,
	notes: SlideRef,
	slicing: CallContext["slicing"] | undefined,
	options: EditOptions
): Promise<void> {
	const dormant = dormantNotesOfBody(session, notes)

	if (dormant === undefined) return

	clearDormantNotes(session, dormant.slide)

	const slide = session.deck.nodes.get(dormant.slide)

	if (!session.deck.slides.includes(dormant.slide) || slide === undefined || slide.notes !== undefined) return

	const made = await applyStep(session, state, dormant.op, slicing, options)

	if (made.ok) state.origins.set(made.revision, dormant.origin)
}

// The text capability's half: a seed or a layout of a dormant notes body makes the notes again first (in the deck's
// turn, as any op).
// (Called before the capability checks its arguments: anything but a shape ref is the capability's to refuse.)
export async function reviveNotesFor(context: CallContext, shape: unknown): Promise<void> {
	if (typeof shape !== "object" || shape === null || !("slide" in shape)) return

	const session = context.session
	const notes = (shape as ShapeRef).slide

	if (dormantNotesOfBody(session, notes) === undefined) return

	const state = stateOf(session)

	await serial(session, () => revive(session, state, notes, context.slicing, {}))
}

// The first text put in notes the last step made (notes.setNotes on a slide, then setText on its notes body): one step
// with it, so a single undo takes the notes slide away with its text and nothing empty is left to save.
function continuesNotes(deck: Deck, history: DeckHistory, op: DeckOp): boolean {
	const top = history.peekUndo()

	if (top === undefined || top.op.family !== "notes" || top.op.kind !== "setNotes") return false
	if (op.family !== "text" || op.kind !== "setText") return false

	return deck.nodes.get(top.op.slide)?.notes === op.target.slide
}

// One op prepared, applied and pushed as a step (inside the deck's turn).
async function applyStep(
	session: EngineSession,
	state: EditState,
	op: DeckOp,
	slicing: CallContext["slicing"] | undefined,
	options: EditOptions
): Promise<CommandResult> {
	try {
		await prepare(session, state, op, slicing, options)
	} catch (error) {
		return refusal(error)
	}

	const deck = session.deck
	const predicted = expandTouches(deck, predictedTouches(deck, op))
	const before = fingerprintTouches(predicted, state.fingerprint)
	const ordersBefore = orderKeys(deck, predicted)

	for (const key of ordersBefore) before.set(key, state.fingerprint(key))

	// Notes started with nothing in them on a slide without notes: nothing the user sees yet (provisional).
	const provisional =
		op.family === "notes" && op.kind === "setNotes" && op.body.paragraphs.length === 0 && deck.nodes.get(op.slide)?.notes === undefined
	const result = applyOp(deck, op, contextFor(session, state))

	if (result.kind === "refused") return { ok: false, refusal: result.reason }
	// Nothing to undo means nothing changed (aligning one shape to itself): no step.
	if (result.inverse.ops.length === 0) return { ok: true, revision: state.history.revision, dirty: state.history.dirty }

	const named = unique([
		...madeTouches(deck, op, result.op),
		...opTouches(result.op),
		...result.inverse.ops.flatMap(back => opTouches(back))
	])
	const touches = unique([...predicted, ...expandTouches(deck, named)])
	const full = new Map<TouchKey, Fingerprint>(before)
	// Keys first named once applied under a node the op names are what it made (absent before).
	const madeKeys = new Set(touches.map(touchKey).filter(key => !before.has(key) && coveredBy(key, named)))

	// What the op made (an allocated id or ref) was absent before; anything else it named only once applied is
	// unknown before, so it reads dirty until its step leaves the saved range.
	for (const touch of touches) {
		const key = touchKey(touch)

		if (!full.has(key)) full.set(key, madeKeys.has(key) ? ABSENT_BEFORE : UNKNOWN_FINGERPRINT)
	}

	// Sibling orders: every parent on the touched slides was read before; one first seen now is a new group.
	for (const key of orderKeys(deck, touches)) if (!full.has(key)) full.set(key, ABSENT_BEFORE)

	const after = new Map<TouchKey, Fingerprint>()

	for (const key of full.keys()) after.set(key, state.fingerprint(key))

	const inverse = inverseWithBytes(result.inverse)

	state.history.push(
		{
			op: result.op,
			inverse,
			touches,
			before: full,
			after,
			bytes: inverse.bytes + opBytesOf(result.op) + fingerprintBytes(full) + fingerprintBytes(after) + touches.length * TOUCH_BYTES,
			burst: burstOf(result.op)
		},
		{ continues: continuesNotes(deck, state.history, result.op), provisional }
	)
	changed(session, state, touches)
	reportJumps(session, result.op, result.inverse)

	return { ok: true, revision: state.history.revision, dirty: state.history.dirty }
}

async function step(
	context: CallContext,
	direction: "undo" | "redo",
	open: ShapeRef | undefined,
	options: EditOptions
): Promise<CommandResult> {
	const session = context.session
	const state = stateOf(session)

	return serial(session, async () => {
		const history = state.history

		// Notes started and left untyped are nothing the user sees: an undo takes them back and undoes what the user did
		// before them (the step they see), in the same call.
		if (direction === "undo") {
			const provisional = history.provisionalTop()

			if (provisional !== undefined) {
				const back = applyAll(session.deck, provisional.inverse.ops, contextFor(session, state))

				if (isRefused(back)) return { ok: false, refusal: back.reason }

				history.retract()
				changed(session, state, provisional.touches)
			}
		}

		const entry = direction === "undo" ? history.peekUndo() : history.peekRedo()

		if (entry === undefined) return { ok: true, revision: history.revision, dirty: history.dirty }

		// A continued step redoes what the step it continues made first (its notes slide, then their text).
		const ops = direction === "undo" ? entry.inverse.ops : entry.lead === undefined ? [entry.op] : [entry.lead, entry.op]
		const base = session.package
		const attempt = async (): Promise<ReturnType<typeof applyAll>> => {
			try {
				for (const op of ops) await prepare(session, state, op, context.slicing, options)
			} catch (error) {
				const answer = refusal(error)

				return refused(answer.ok ? "failed" : answer.refusal)
			}

			return applyAll(session.deck, ops, contextFor(session, state))
		}
		const first = await attempt()
		// Read against a package a save's commit replaced meanwhile (see command): once more against the new one.
		const result = isRefused(first) && session.package !== base ? await attempt() : first

		if (isRefused(result)) return { ok: false, refusal: result.reason }

		if (direction === "undo") {
			history.undone()
		} else {
			// A redo keeps the inverse it makes now (its bytes read from the base source as it is after any rebase).
			const fresh = result.inverses[0]

			if (fresh !== undefined) history.replaceInverse(entry, inverseWithBytes(fresh))

			history.redone()
		}

		changed(session, state, entry.touches)

		const seed = await seedFor(context, open, entry.touches)

		return { ok: true, revision: history.revision, dirty: history.dirty, ...(seed === undefined ? {} : { seed }) }
	})
}

// Takes back the step that made `revision` while it is still the last thing done (saves aside): its inverse applied
// and the history as it was before it (its redo branch back, no redo step left). Refused stale otherwise.
async function retract(context: CallContext, asked: number, options: EditOptions): Promise<CommandResult> {
	let revision = asked
	const session = context.session
	const state = stateOf(session)

	return serial(session, async () => {
		const history = state.history
		const dormant = dormantNotesOfOrigin(session, revision)

		// Taken back by a save already, and never made again: they are gone for good.
		if (dormant !== undefined) {
			clearDormantNotes(session, dormant.slide)

			return { ok: true, revision: history.revision, dirty: history.dirty }
		}

		// The revision the page names, or the one its notes were made again under (a keystroke after a save).
		const current = history.provisionalRevision()

		if (current !== undefined && current !== revision && originOf(state, current) === revision) revision = current

		const entry = history.retractable(revision)

		if (entry === undefined) return { ok: false, refusal: "stale" }

		try {
			for (const op of entry.inverse.ops) await prepare(session, state, op, context.slicing, options)
		} catch (error) {
			return refusal(error)
		}

		// A prepare may have yielded: the step must still be the one to take back.
		if (history.retractable(revision) !== entry) return { ok: false, refusal: "stale" }

		const result = applyAll(session.deck, entry.inverse.ops, contextFor(session, state))

		if (isRefused(result)) return { ok: false, refusal: result.reason }

		history.retract()
		changed(session, state, entry.touches)

		return { ok: true, revision: history.revision, dirty: history.dirty }
	})
}

// The parts a step changed (where each key it touched lives, before and after).
function stepParts(step: HistoryStep): Set<string> {
	const out = new Set<string>()

	for (const map of [step.before, step.after]) {
		for (const [key, value] of map) {
			if (value.part !== undefined) out.add(value.part)
			if (key.startsWith("p:")) out.add(key.slice(key.indexOf(":", 2) + 1))
		}
	}

	return out
}

// The steps that made what the writer refused reverted: undone from the newest, then the undone steps that did not
// make it applied again, oldest first (a new step each). What was refused: with `edits`, the steps since the save that
// change the shape's refused group (else those that made the shape whole: its insert, its slide copied); without, or
// when no step names it, every step whose net effect touches `parts`, until none of them differs from the saved state.
// The count of steps reverted. Runs inside the save's turn.
async function revert(
	session: EngineSession,
	state: EditState,
	parts: ReadonlySet<string>,
	options: EditOptions,
	edits?: RefusedEdits
): Promise<number> {
	const history = state.history
	// The keys a step changed, a whole node's marked when the step made it (a shape it made is named by that key alone).
	const keysOf = (entry: HistoryStep): readonly { readonly key: string; readonly made: boolean }[] => {
		const out: { key: string; made: boolean }[] = []

		for (const [key, before] of entry.before) {
			const after = entry.after.get(key)

			if (after !== undefined && after.digest === before.digest && after.exists === before.exists) continue

			const made = !before.exists && after?.exists === true

			if (made && key.startsWith("s:") && !key.endsWith(":n")) continue

			out.push({ key, made })
		}

		return out
	}
	const since = history.sinceSaved
	const window = since === undefined ? undefined : history.steps().slice(history.depth.undo - since, history.depth.undo)
	const dirty = (): readonly { readonly key: string; readonly made: boolean }[] =>
		[...history.dirtyTouchKeys()].map(key => ({ key, made: history.savedFingerprint(key)?.exists === false }))
	const names = (test: (key: string, made: boolean) => boolean): boolean =>
		window !== undefined
			? window.some(entry => keysOf(entry).some(each => test(each.key, each.made)))
			: dirty().some(each => test(each.key, each.made))
	const named = edits === undefined ? undefined : [edits.changes, edits.alters, edits.makes].find(test => names(test))
	const related = (entry: HistoryStep): boolean =>
		named !== undefined ? keysOf(entry).some(each => named(each.key, each.made)) : [...stepParts(entry)].some(part => parts.has(part))
	let left = named === undefined || window === undefined ? undefined : window.filter(related).length
	const touched = (): boolean => {
		if (left !== undefined) return left > 0
		if (named !== undefined) return dirty().some(each => named(each.key, each.made))

		for (const part of deckChanges(session.deck, history, state.fingerprint).parts.keys()) if (parts.has(part)) return true

		return false
	}
	const unrelated: DeckOp[] = []
	let count = 0

	while (touched()) {
		const entry = history.peekUndo()

		if (entry === undefined) break

		try {
			for (const op of entry.inverse.ops) await prepare(session, state, op, undefined, options)
		} catch {
			break
		}

		const result = applyAll(session.deck, entry.inverse.ops, contextFor(session, state))

		if (isRefused(result)) break

		history.undone()
		changed(session, state, entry.touches)

		if (related(entry)) {
			count++

			if (left !== undefined) left--
		} else unrelated.unshift(entry.op)
	}

	for (const op of unrelated) {
		const result = await applyStep(session, state, op, undefined, options)

		if (!result.ok) {
			count++

			continue
		}

		// A step that keeps a refused part changed after all goes again (a step named by `edits` never is one).
		if (named === undefined && touched()) {
			const entry = history.peekUndo()

			const back = entry === undefined ? undefined : applyAll(session.deck, entry.inverse.ops, contextFor(session, state))

			if (entry !== undefined && back !== undefined && !isRefused(back)) {
				history.undone()
				changed(session, state, entry.touches)
			}

			count++
		}
	}

	return count
}

// The edit capability, proving slides with `options.emit` (tests pass their own emitters).
export function createEditCapability(options: EditOptions = {}): EditCapability {
	return {
		command: (context, op, open) => command(context, op, options, open),
		undo: (context, open) => step(context, "undo", open, options),
		redo: (context, open) => step(context, "redo", open, options),
		retract: (context, revision) => retract(context, revision, options)
	}
}

export const editCapability: EditCapability = createEditCapability()

// The pptx package's chart parts, and those of a slide an undo restored after a save left its parts out: the bytes
// its delete held (a chart and its workbook read as they were).
export function chartPartSource(session: EngineSession, parts: PptxParts): ChartPartSource {
	const restored = (name: string): RawPart | undefined => {
		const key = partKey(name)

		for (const node of session.deck.nodes.values()) {
			const src = node.src

			if (src?.format !== "pptx" || !src.part.startsWith("raw:")) continue

			const held = stateOf(session)
				.raw.get(src.part)
				?.parts?.find(each => partKey(each.name) === key)

			if (held !== undefined) return held
		}

		return undefined
	}
	const opc = parts.opc

	return {
		opc: {
			entry: name => opc.entry(name) ?? restoredEntry(restored(name)),
			read: async (name, slicing) => (opc.has(name) ? opc.read(name, slicing) : (restored(name)?.bytes ?? opc.read(name, slicing))),
			relationships: async name => {
				const held = opc.has(name) ? undefined : restored(name)

				if (held === undefined) return opc.relationships(name)

				return held.rels === undefined
					? new Relationships([])
					: parseRelationships(held.rels, held.name.startsWith("/") ? held.name.slice(1) : held.name)
			}
		},
		document: part => parts.document(part)
	}
}

function restoredEntry(part: RawPart | undefined): { readonly uncompressedSize: number } | undefined {
	return part === undefined ? undefined : { uncompressedSize: part.bytes.length }
}

// What the save capability needs of a session's edits.
export interface SessionEdits {
	readonly history: DeckHistory
	// The changes against the saved state, now.
	changes(): DeckChanges
	// Runs `task` with commands queued until it ends (a save's snapshot).
	exclusive<T>(task: () => Promise<T>): Promise<T>
	// A document the session holds for re-read source markup ("raw:" names), and the part it was, for the writer.
	rawDocument(name: string): XmlDocument | undefined
	rawPart(name: string): RawPart | undefined
	// A restored slide's (its "raw:" name): every part its restore held, the slide first, for the writer to add back.
	rawParts(name: string): readonly RawPart[] | undefined
	// The proof tally of every slide proved so far.
	proofs(): ReadonlyMap<SlideRef, ProofTally>
	// Lets go of diagram parts ops held ("raw:" names) that a save wrote into the package's parts and no frame names now.
	releaseHeld(names: readonly string[]): void
}

export function sessionEdits(session: EngineSession): SessionEdits {
	const state = stateOf(session)

	return {
		history: state.history,
		changes: () => deckChanges(session.deck, state.history, state.fingerprint),
		exclusive: task => serial(session, task),
		rawDocument: name => state.raw.get(name)?.document,
		rawPart: name => state.raw.get(name)?.part,
		rawParts: name => state.raw.get(name)?.parts,
		proofs: () => state.proved,
		releaseHeld: names => {
			const parts = pptxParts(session.deck)

			for (const name of names) {
				const held = state.raw.get(name)

				// Only a part an op held (no restored slide's markup, which the writer reads by name).
				if (held === undefined || held.part !== undefined || held.parts !== undefined || held.nodePart !== undefined) continue

				state.raw.delete(name)
				parts?.forget(name)
			}
		}
	}
}
