import { DIAGRAM_CONTENT_TYPES } from "../../core/smartart/edit"
import { insertedMediaWritten } from "../../core/presentation/edit/apply/media"
import {
	diagramOwnerTargets,
	diagramRelationshipOwner,
	diagramRelationshipTargets,
	insertedDiagramParts
} from "../../core/presentation/edit/apply/smartart"
import { insertedImageWritten, insertedImageWrittenFor } from "../../core/presentation/edit/apply/picture"
import type { InsertedImage, RawPart } from "../../core/presentation/edit/ops"
import type { PartChange } from "../../core/opc/index"
import type { Deck } from "../../core/presentation/model"
import { decodeUtf8, NodeKind, transcodeUtf16, type XmlDocument } from "../../core/xml/index"
import type { EngineSession } from "./engine"
import type { DeckHistory } from "../../core/presentation/edit/history"
import { sessionEdits } from "./engine/edit"
import { odpParts } from "./engine/open/odp"
import { pptxParts } from "./engine/open/pptx"

// The parts a session's saves authored (diagram parts, pictures and media they added) and which of them a save leaves
// out: those neither the deck as it is now nor any step the history still holds can reach. A picture replaced, or a
// diagram written anew, keeps its earlier parts while an undo or redo may name them again; once the history lets go of
// those steps, the next save drops them, with their relationships, content types and manifest entries. Parts of the
// source file are never left out: only what this session wrote is judged.
//
// Reach is judged by name, conservatively (a name found anywhere keeps the part):
//   - the deck: every parsed node, read whole (part names in fills, frames, media; inserted images and media by their
//     registry ids, which name the parts a save wrote them to), and the held markup its diagram frames name;
//   - the history: every held step's op and inverse, raw bytes included (a restore's parts, held diagram data naming
//     pictures by pending ids, a deleted slide's relationships);
//   - pptx: what the parts reached relate in turn (a diagram's pictures); a part some unparsed or unauthored part
//     relates stays; ODP: a part the content.xml or styles.xml the save writes names stays (the writer judges that,
//     core/odp/write/save.ts, on the bytes it writes: its copied pages are the package's).

const AUTHORED_PPTX = /^ppt\/(?:diagrams|media)\/[^/]+$/u
const AUTHORED_ODP = /^(?:Pictures|Media)\/[^/]+$/u
const INSERTED = "inserted:"
const HELD = "raw:"
const CHUNK = 8192

// The platform's UTF-8 decoder (one native pass); hosts without one (Hermes) take the bytes as one-byte characters,
// which keeps the ASCII names and ids searched for as they are (no other byte lowers into one).
const UTF8 = (() => {
	const constructor = (globalThis as { TextDecoder?: new () => { decode(bytes: Uint8Array): string } }).TextDecoder

	return typeof constructor === "function" ? new constructor() : undefined
})()

function textOf(bytes: Uint8Array): string {
	if (UTF8 !== undefined) return UTF8.decode(bytes)

	let text = ""

	for (let at = 0; at < bytes.length; at += CHUNK)
		text += String.fromCharCode.apply(null, bytes.subarray(at, Math.min(bytes.length, at + CHUNK)) as unknown as number[])

	return text
}
const MAX_DEPTH = 256
// Byte fields that hold no markup: a chart's embedded workbook, a custom path's commands, a timegraph's state.
const BINARY_FIELDS = new Set(["workbook", "commands", "state"])

const authored = new WeakMap<Deck, Set<string>>()

// A part name as compared here: no leading "/" or pending-id prefix, lower case.
function key(name: string): string {
	let value = name

	if (value.startsWith("part:")) value = value.slice("part:".length)

	while (value.startsWith("/")) value = value.slice(1)

	return value.toLowerCase()
}

// The entries a written save added that are the session's own from now on (zip names).
export function authoredEntries(deck: Deck, added: readonly PartChange[] | undefined): string[] {
	const pattern = deck.format === "odp" ? AUTHORED_ODP : AUTHORED_PPTX

	return (added ?? []).map(change => change.name).filter(name => pattern.test(name))
}

// A committed save: the entries it added are the session's, those it left out are gone.
export function commitAuthoredEntries(deck: Deck, added: readonly string[] | undefined, pruned: readonly string[] | undefined): void {
	if ((added === undefined || added.length === 0) && (pruned === undefined || pruned.length === 0)) return

	let set = authored.get(deck)

	if (set === undefined) {
		set = new Set()
		authored.set(deck, set)
	}

	for (const name of pruned ?? []) set.delete(key(name))
	for (const name of added ?? []) set.add(key(name))
}

// Markup searched for part names: decoded as it is collected, lowered once on the first search (most saves search
// none: every authored part is reached by name).
class Markup {
	readonly texts: string[] = []
	private lowered: string[] | undefined

	// A UTF-16 part (its byte order mark) is transcoded first.
	add(bytes: Uint8Array): void {
		const little = bytes[0] === 0xff && bytes[1] === 0xfe

		this.texts.push(textOf(little || (bytes[0] === 0xfe && bytes[1] === 0xff) ? transcodeUtf16(bytes, 2, little) : bytes))
		this.lowered = undefined
	}

	// Whether any text names the part (its last two path segments: a relationship's relative target, a pending id, a
	// full name; part keys are lower case).
	names(part: string): boolean {
		const tail = part.split("/").slice(-2).join("/")

		this.lowered ??= this.texts.map(text => text.toLowerCase())

		return this.lowered.some(text => text.includes(tail))
	}
}

// What the deck and the history name: part keys, and the markup to search for names.
interface Reach {
	readonly names: Set<string>
	readonly markup: Markup
	// The names (not a held part's own, whose bytes an undo writes back) the history holds: what an undo or redo may
	// name again.
	readonly history: Set<string>
	// Diagram data parts with pictures of their own a step holds the bytes of (an undo writes them back there).
	readonly held: Set<string>
	// Every name but a held part's own.
	readonly byName: Set<string>
}

function nameIn(reach: Reach, name: string): void {
	reach.names.add(name)
	reach.byName.add(name)
}

// A part name has a path ("/ppt/media/image1.png", "Pictures/1.png") or is one the session holds; text runs and the
// like are none.
function isPartName(value: string): boolean {
	return value.length > 1 && value.length < 1024 && (value.includes("/") || value.startsWith(HELD))
}

function isSourceRef(value: unknown): value is { readonly format: string; readonly part: string } {
	const candidate = value as { readonly format?: unknown; readonly part?: unknown } | null

	return typeof candidate === "object" && candidate !== null && typeof candidate.format === "string" && typeof candidate.part === "string"
}

function isRawPart(value: object): value is RawPart {
	const candidate = value as Partial<RawPart>

	return candidate.bytes instanceof Uint8Array && typeof candidate.contentType === "string" && typeof candidate.name === "string"
}

// A held part's content type is markup (its relationships always are): a picture's or a video's bytes name no parts.
function isMarkup(contentType: string): boolean {
	const type = (contentType.split(";")[0] ?? "").trim().toLowerCase()

	return type.endsWith("xml")
}

function isInsertedImage(value: object): value is InsertedImage {
	const candidate = value as Partial<InsertedImage>

	return candidate.bytes instanceof Uint8Array && typeof candidate.contentType === "string" && typeof candidate.width === "number"
}

function visit(value: unknown, deck: Deck, reach: Reach, seen: WeakSet<object>, depth: number): void {
	if (depth > MAX_DEPTH) return

	if (typeof value === "string") {
		if (value.startsWith(INSERTED)) {
			const id = Number(value.slice(INSERTED.length))
			const media = insertedMediaWritten(deck, id)
			const image = insertedImageWritten(deck, id)?.part

			if (media !== undefined) nameIn(reach, key(media))
			if (image !== undefined) nameIn(reach, key(image))
		} else if (isPartName(value)) nameIn(reach, key(value))

		return
	}

	if (typeof value !== "object" || value === null) return
	if (value instanceof Uint8Array) {
		reach.markup.add(value)

		return
	}
	if (ArrayBuffer.isView(value) || seen.has(value)) return

	seen.add(value)

	if (isRawPart(value)) {
		reach.names.add(key(value.name))

		if (isMarkup(value.contentType)) reach.markup.add(value.bytes)
		// Diagram data or a drawing with pictures of its own: an undo names it again, its relationships naming them (a
		// part's bytes come back, its relationships only with the part).
		if (
			(value.contentType === DIAGRAM_CONTENT_TYPES.data || value.contentType === DIAGRAM_CONTENT_TYPES.drawing) &&
			/:(?:embed|link)="/u.test(reach.markup.texts.at(-1) ?? "")
		)
			reach.held.add(key(value.name))
		if (value.rels !== undefined) reach.markup.add(value.rels)

		for (const name of value.absent ?? []) reach.names.add(key(name))

		return
	}

	// A diagram an insert op made, written by a save: a redo names those parts again.
	for (const part of insertedDiagramParts(deck, value)) nameIn(reach, key(part))

	// An inserted image (an op's, an undo's): the part a save wrote it to; its pixels are no names.
	if (isInsertedImage(value)) {
		const written = insertedImageWrittenFor(deck, value)?.part

		if (written !== undefined) nameIn(reach, key(written))

		return
	}

	if (value instanceof Map) {
		for (const [k, v] of value) {
			visit(k, deck, reach, seen, depth + 1)
			visit(v, deck, reach, seen, depth + 1)
		}

		return
	}

	if (value instanceof Set || Array.isArray(value)) {
		for (const item of value as Iterable<unknown>) visit(item, deck, reach, seen, depth + 1)

		return
	}

	const record = value as Record<string, unknown>

	for (const name in record) {
		if (!Object.hasOwn(record, name)) continue

		const item = record[name]

		// An inserted image's registry id: the part a save wrote it to.
		if (name === "inserted" && typeof item === "number") {
			const written = insertedImageWritten(deck, item)?.part

			if (written !== undefined) nameIn(reach, key(written))

			continue
		}

		if (item instanceof Uint8Array && BINARY_FIELDS.has(name)) continue
		// A source ref names the markup a shape or slide was read from, not a part it uses: only one the session holds
		// (re-read markup) is searched.
		if (name === "src" && isSourceRef(item)) {
			if (item.part.startsWith(HELD)) nameIn(reach, key(item.part))

			continue
		}

		visit(item, deck, reach, seen, depth + 1)
	}
}

// The deck's parsed nodes, the held markup its frames name, and every step the history holds.
function reachOf(session: EngineSession, heldMarkup: (name: string) => Uint8Array | undefined, history: DeckHistory | undefined): Reach {
	const deck = session.deck
	const reach: Reach = { names: new Set(), markup: new Markup(), history: new Set(), byName: new Set(), held: new Set() }
	const seen = new WeakSet<object>()

	for (const node of deck.nodes.values()) visit(node, deck, reach, seen, 0)

	// Held markup (an edited diagram's data, a restored slide) named by the model; the package's own parts name what
	// they use by relationships (followed below), so only the session's are searched.
	for (const name of [...reach.names]) {
		const bytes = name.startsWith(HELD) ? heldMarkup(name) : undefined

		if (bytes !== undefined) reach.markup.add(bytes)
	}

	// The history on its own (a step may hold objects the deck holds too: a deleted slide's copy of a frame): what it
	// names, whether or not the deck does.
	const steps: Reach = { names: new Set(), markup: reach.markup, history: new Set(), byName: new Set(), held: new Set() }
	const stepsSeen = new WeakSet<object>()

	const held = history?.steps() ?? []
	// A redoable step's inverse is made again when it is redone: the parts it holds are not written back from it.
	const redoInverses: Reach = { ...steps, held: new Set() }
	const undoable = history?.depth.undo ?? 0

	held.forEach((step, at) => {
		visit(step.op, deck, steps, stepsSeen, 0)
		visit(step.inverse.ops, deck, at < undoable ? steps : redoInverses, stepsSeen, 0)
	})

	for (const name of steps.names) reach.names.add(name)
	for (const name of steps.held) reach.held.add(name)
	for (const name of steps.byName) {
		reach.byName.add(name)
		reach.history.add(name)
	}

	// Pending ids in held bytes name parts and inserted images.
	for (const text of reach.markup.texts)
		for (const match of text.matchAll(/inserted:(\d+)/gu)) visit(`${INSERTED}${match[1] ?? ""}`, deck, reach, seen, 0)

	return reach
}

function candidates(deck: Deck, has: (name: string) => boolean): string[] {
	return [...(authored.get(deck) ?? [])].filter(has)
}

// The entries (zip names) the next save of `session` leaves out.
export async function prunableEntries(session: EngineSession): Promise<string[]> {
	const deck = session.deck

	if ((authored.get(deck)?.size ?? 0) === 0) return []

	const history = sessionEdits(session).history

	return deck.format === "odp" ? prunableOdp(session, history) : (await judgePptx(session, history)).prune
}

// What the next save of `session` does with the parts its saves authored: those it leaves out, and those a step the
// history holds names by name (pptx; not a held part's own, whose bytes an undo writes back), which it keeps even where
// a removed slide was their only referrer (a later save leaves them out once nothing can).
export async function prunePlan(
	session: EngineSession,
	saving?: DeckHistory
): Promise<{ readonly prune: string[]; readonly keep: string[]; readonly hold: string[] | undefined }> {
	const deck = session.deck
	const made = (authored.get(deck)?.size ?? 0) > 0
	// The edit engine's history, when it is the one the save keeps (never made here: making it would take the deck as
	// it is now as saved).
	const history = saving ?? (made ? sessionEdits(session).history : undefined)

	if (deck.format === "odp") return { prune: made ? prunableOdp(session, history) : [], keep: [], hold: [] }
	// The history unknown (no edit session the save keeps): nothing to leave out, and what the session holds unknown.
	if (history === undefined) return { prune: [], keep: [], hold: undefined }
	// Nothing authored and no step held: nothing to leave out, keep or hold.
	if (!made && history.steps().length === 0) return { prune: [], keep: [], hold: [] }

	return judgePptx(session, history)
}

function prunableOdp(session: EngineSession, history: DeckHistory | undefined): string[] {
	const parts = odpParts(session.deck)

	if (parts === undefined) return []

	const entries = new Map(parts.odf.archive.entries.map(entry => [key(entry.name), entry.name]))
	const list = candidates(session.deck, name => entries.has(name))

	if (list.length === 0) return []

	const reach = reachOf(session, () => undefined, history)
	return list.filter(name => !reach.names.has(name) && !reach.markup.names(name)).map(name => entries.get(name) as string)
}

// Every package relationship by source part key (cached per package).
interface Related {
	readonly id: string
	readonly target: string
}

const relationshipIndexes = new WeakMap<object, Promise<Map<string, Related[]>>>()

function relationshipIndex(session: EngineSession): Promise<Map<string, Related[]>> {
	const parts = pptxParts(session.deck)
	const pkg = session.package

	if (parts === undefined) return Promise.resolve(new Map())

	let index = relationshipIndexes.get(pkg)

	if (index === undefined) {
		index = (async () => {
			const out = new Map<string, Related[]>()

			for (const entry of parts.opc.entries()) {
				const match = /^(.*?)_rels\/([^/]*)\.rels$/iu.exec(entry.name)

				if (match === null) continue

				const source = `${match[1] ?? ""}${match[2] ?? ""}`

				if (source === "") continue

				const relationships = await parts.opc.relationships(source)

				out.set(
					key(source),
					relationships.all.flatMap(relationship =>
						relationship.external || relationship.partName === undefined
							? []
							: [{ id: relationship.id, target: key(relationship.partName) }]
					)
				)
			}

			return out
		})()
		relationshipIndexes.set(pkg, index)
	}

	return index
}

const DIAGRAM_DATA = /^ppt\/diagrams\/[^/]+\.xml$/u
const DRAWING_IDS = /\brelId="([^"]+)"/gu

// The drawings a diagram data part names, through the slides that relate it.
async function drawingsOf(parts: NonNullable<ReturnType<typeof pptxParts>>, name: string, slides: readonly string[]): Promise<string[]> {
	const document = parts.document(`/${name}`)
	const bytes = document?.bytes ?? (parts.opc.has(name) ? await parts.opc.read(name) : undefined)

	if (bytes === undefined) return []

	const ids = [...decodeUtf8(bytes, 0, bytes.length).matchAll(DRAWING_IDS)].map(match => match[1] ?? "").filter(id => id !== "")
	const out: string[] = []

	for (const slide of slides) {
		const relationships = await parts.opc.relationships(slide)

		for (const id of ids) {
			const target = relationships.byId(id)?.partName

			if (target !== undefined) out.push(key(target))
		}
	}

	return out
}

// Whether an attribute of `document` names relationship `id` anywhere but in a shape of its tree whose id is not
// `kept` (one the model dropped).
function namedOutsideDropped(document: XmlDocument, id: string, kept: ReadonlySet<number>): boolean {
	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element) continue
		// Attributes that cannot be read keep what they may name.
		if (document.isMalformed(node)) return true
		if (document.attributeSpans(node).length === 0) continue
		if (!document.attributes(node).some(attribute => attribute.value === id && attribute.name.includes(":"))) continue

		let shape = node

		while (shape >= 0 && document.parent(shape) >= 0 && document.localName(document.parent(shape)) !== "spTree")
			shape = document.parent(shape)

		const tree = shape < 0 ? -1 : document.parent(shape)

		if (tree < 0 || document.localName(tree) !== "spTree") return true
		const shapeId = cNvPrId(document, shape)

		// A shape the model cannot tell by its id (an mc:AlternateContent at the top) keeps what it names.
		if (shapeId === undefined || kept.has(Number(shapeId))) return true
	}

	return false
}

// The id of a shape element's own non-visual properties (p:nvSpPr/p:cNvPr and its kin, the first one in it).
function cNvPrId(document: XmlDocument, shape: number): string | undefined {
	for (let child = document.firstChild(shape); child >= 0; child = document.nextSibling(child)) {
		if (document.kinds[child] !== NodeKind.Element || !document.localName(child).startsWith("nv")) continue

		for (let inner = document.firstChild(child); inner >= 0; inner = document.nextSibling(inner))
			if (document.kinds[inner] === NodeKind.Element && document.localName(inner) === "cNvPr") return document.attribute(inner, "id")
	}

	return undefined
}

async function judgePptx(
	session: EngineSession,
	history: DeckHistory | undefined
): Promise<{ prune: string[]; keep: string[]; hold: string[] }> {
	const parts = pptxParts(session.deck)

	if (parts === undefined) return { prune: [], keep: [], hold: [] }

	const entries = new Map([...parts.opc.entries()].map(entry => [key(entry.name), entry.name]))
	const list = candidates(session.deck, name => entries.has(name))

	const index = await relationshipIndex(session)
	const reach = reachOf(session, name => parts.document(`/${name}`)?.bytes ?? parts.document(name)?.bytes, history)
	// What the parts reached relate in turn: a node's own relationships may be dead (a replaced picture's), so only
	// parts reached by name lead on, never the nodes that relate them.
	const nodeParts = new Set([...session.deck.nodes.values()].map(node => key(node.part)))
	const live = new Set<string>()
	const referrers = new Map<string, string[]>()

	for (const [source, targets] of index)
		for (const { target } of targets) {
			const list = referrers.get(target)

			if (list === undefined) referrers.set(target, [source])
			else list.push(source)
		}

	// A node's markup as the package has it names the part (a relationship id of its own): whatever the model reads
	// of it (a picture the reader keeps unmodelled, a slide an undo restored), it is in use; unless only shapes of its
	// tree the model no longer has name it (a picture inserted, saved and undone: the save writes the slide without it).
	const markup = new Map<string, string>()
	const nodesByPart = new Map([...session.deck.nodes.values()].map(node => [key(node.part), node]))
	const namedByMarkup = async (source: string, target: string): Promise<boolean> => {
		let text = markup.get(source)
		const document = parts.document(`/${entries.get(source) ?? source}`)

		if (text === undefined) {
			const bytes = document?.bytes ?? (await read(entries.get(source)))

			text = bytes === undefined ? "" : decodeUtf8(bytes, 0, bytes.length)
			markup.set(source, text)
		}

		const ids = (index.get(source) ?? []).filter(related => related.target === target && text.includes(`"${related.id}"`))
		const node = nodesByPart.get(source)

		if (ids.length === 0 || document === undefined || node === undefined) return ids.length > 0

		const kept = new Set(node.shapes.map(shape => shape.sourceId ?? shape.id))

		return ids.some(related => namedOutsideDropped(document, related.id, kept))
	}
	const read = async (name: string | undefined): Promise<Uint8Array | undefined> =>
		name !== undefined && parts.opc.has(name) ? parts.opc.read(name) : undefined

	// Everything the parts kept relate, a diagram's data its drawing included.
	const spreadInto = async (into: Set<string>, queue: string[]): Promise<void> => {
		for (let at = 0; at < queue.length; at++) {
			const name = queue[at] as string

			if (into.has(name) || nodeParts.has(name)) continue

			into.add(name)

			for (const { target } of index.get(name) ?? []) if (!into.has(target)) queue.push(target)

			// A diagram's data names its drawing by a relationship of the slide (dsp:dataModelExt@relId).
			if (DIAGRAM_DATA.test(name))
				for (const drawing of await drawingsOf(parts, name, referrers.get(name) ?? [])) if (!into.has(drawing)) queue.push(drawing)
		}
	}
	const spread = (queue: string[]): Promise<void> => spreadInto(live, queue)

	// Held data with pictures of its own names them through its package part's relationships (the writer relates them
	// from the data it writes): what that part relates is in use, not the part itself.
	const owned: string[] = []

	for (const name of reach.names) {
		if (!name.startsWith(HELD)) continue

		const owner = diagramRelationshipOwner(session.deck, name)

		if (owner !== undefined) for (const { target } of index.get(key(owner)) ?? []) owned.push(target)
		for (const target of diagramRelationshipTargets(session.deck, name)?.values() ?? []) owned.push(key(target))
	}

	const pictures = new Set<string>()

	// Held data the deck's frames name, or a step the history holds writes back, names its pictures through the package
	// part it was read from (or the targets read for it): a removal never takes those while it is named.
	for (const name of new Set([...reach.held, ...[...reach.names].filter(each => each.startsWith(HELD))])) {
		// A package part the step writes back keeps its own relationships; held bytes keep their owner's.
		const owner = name.startsWith(HELD) ? diagramRelationshipOwner(session.deck, name) : name

		if (owner !== undefined) {
			for (const { target } of index.get(key(owner)) ?? []) pictures.add(target)
			for (const target of diagramOwnerTargets(session.deck, owner)?.values() ?? []) pictures.add(key(target))
		}
		for (const target of diagramRelationshipTargets(session.deck, name)?.values() ?? []) pictures.add(key(target))
	}

	// And the package pictures held diagram data names by pending ids (an edit's data, a copy's of it).
	for (const text of reach.markup.texts) for (const match of text.matchAll(/"(part:[^"]+)"/gu)) pictures.add(key(match[1] ?? ""))

	await spread([...[...reach.names].filter(name => entries.has(name) && !nodeParts.has(name)), ...owned, ...pictures])

	const roots = new Set(list.filter(name => !live.has(name)))
	const named = [...roots].filter(name => reach.markup.names(name))

	// Parts named by held text keep what they relate and, for a diagram's data, its drawing: with those reached by
	// name, what the session can name again.
	await spread(named)

	// What only the history can name again (with what it relates): kept even where a removed slide took it.
	const recalled = new Set<string>()

	await spreadInto(
		recalled,
		[...reach.history].filter(name => entries.has(name) && !nodeParts.has(name))
	)

	const reached = list.filter(name => recalled.has(name))
	// Any package part a step the history holds names, or writes diagram data back into (whose relationships name its
	// pictures), with what it relates: a save never lets go of one.
	const kept = new Set<string>()

	await spreadInto(
		kept,
		[...reach.history, ...reach.held].filter(name => entries.has(name) && !nodeParts.has(name))
	)

	const hold = [...kept].filter(name => entries.has(name)).map(name => entries.get(name) as string)
	const pictured = [...pictures].filter(name => entries.has(name)).map(name => entries.get(name) as string)

	if (list.length === 0) return { prune: [], keep: pictured, hold }

	const marked: string[] = []

	for (const name of roots)
		if (!live.has(name))
			for (const source of referrers.get(name) ?? [])
				if (nodeParts.has(source) && (await namedByMarkup(source, name))) {
					marked.push(name)

					break
				}

	// Parts a slide's markup names (as the package has it) stay, with what they relate.
	await spread(marked)

	for (const name of live) roots.delete(name)

	// A part related from anything but a parsed node or another part left out stays (its referrer is not judged here).
	for (let changed = true; changed;) {
		changed = false

		for (const name of roots) {
			if ((referrers.get(name) ?? []).every(source => nodeParts.has(source) || roots.has(source))) continue

			roots.delete(name)
			changed = true
		}
	}

	return {
		prune: [...roots].map(name => entries.get(name) as string),
		keep: [...reached.map(name => entries.get(name) as string), ...pictured],
		hold
	}
}
