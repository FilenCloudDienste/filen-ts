import { OpcError, ZipError } from "../../opc/index"
import { XmlError, type XmlDocument } from "../../xml/index"
import type { DocxModel, MaxIds, Story } from "../model/index"
import { parseNumbering, type Numbering } from "../numbering/index"
import { gateReasons, type DocxGateReason, type DocxPackage } from "../package"
import { gateLifted, protectionMode, protectionOf, readOnlyExceptions } from "./protection"
import { bindingsKnown, partHasBindings } from "../forms/binding"
import { PropsStore } from "../props/index"
import { DocxStyles, PropertyResolver, parseStyles, styleSettings } from "../styles/index"
import { parseTheme } from "../theme/index"
import type { NewList } from "./formats"
import { RunBases } from "./formatting"

// What editing one document needs besides the model: the shared property store (so run bases intern
// with everything else), styles, numbering and the resolver for the formatting state of a selection.
export interface DocxEditContext {
	readonly model: DocxModel
	readonly store: PropsStore
	readonly styles: DocxStyles
	readonly numbering: Numbering | undefined
	readonly resolver: PropertyResolver
	readonly bases: RunBases
	// Gate 0: why the document opens view-only (empty when it may be edited).
	readonly gate: readonly DocxGateReason[]
	// Lists commands started, by their (negative) id, shared by every session of the document.
	readonly newLists: Map<number, NewList>
	// Built-in paragraph styles commands used that the document lacks: id -> built-in name.
	readonly newStyles: Map<string, string>
	// Text width (twips) of the section an added style that depends on it was added for (Header, Footer), by id.
	readonly newStyleWidths: Map<string, number>
	// New ids per id space, shared by every session of the document.
	readonly ids: DocxIds
	// Who edits and when, for what records an author (comments, tracked changes).
	readonly identity: DocxIdentity
	// Media commands insert (image bytes registered ahead), by handle.
	readonly media: DocxMediaStore
	// Review state of the document as edited.
	readonly review: DocxReviewState
	// Stories the editor added (a new note, comment, header), with where the save puts them.
	readonly newStories: Map<Story, NewStory>
	// The document's protection was stopped for this session (EditContextParts.protectionUnlocked).
	readonly protectionUnlocked?: boolean
}

// The initials a comment records for an author (w:initials): the first letter of each part of the name, at
// most nine (Word's limit).
export function authorInitials(name: string): string | undefined {
	const initials = name
		.split(/[\s-]+/u)
		.filter(part => part !== "")
		.map(part => String.fromCodePoint(part.codePointAt(0) ?? 0).toUpperCase())
		.join("")
		.slice(0, 9)

	return initials === "" ? undefined : initials
}

export type DocxIdSpace = keyof MaxIds

// The smallest id handed out per space: notes start at 1 (Word keeps -1 and 0 for the separator notes),
// drawing ids at 1, the rest at 0.
const FIRST_IDS: Readonly<Record<DocxIdSpace, number>> = {
	docPr: 1,
	bookmark: 0,
	comment: 0,
	revision: 0,
	footnote: 1,
	endnote: 1,
	permission: 0
}

// New ids are the largest the document uses plus one, per id space (see FIRST_IDS).
export class DocxIds {
	private readonly last: MaxIds
	private readonly paraIds = new Set<number>()

	constructor(max: Readonly<MaxIds>) {
		this.last = { ...max }
	}

	next(space: DocxIdSpace): number {
		this.last[space] = Math.max(this.last[space], FIRST_IDS[space] - 1) + 1

		return this.last[space]
	}

	// What `next` hands out from, to put back after work whose ids are thrown away (DocxEditorSession.warmUp).
	saved(): Readonly<MaxIds> {
		return { ...this.last }
	}

	restore(saved: Readonly<MaxIds>): void {
		Object.assign(this.last, saved)
	}

	// An id a feature took over (it is never handed out).
	reserve(space: DocxIdSpace, id: number): void {
		this.last[space] = Math.max(this.last[space], id)
	}

	// A new w14:paraId: random, below 0x80000000 and not 0 (Word's range), unlike any in `taken` (the ids of
	// the parts it goes into) or handed out before.
	paraId(taken: (id: number) => boolean, random: () => number = Math.random): string {
		for (;;) {
			const id = Math.floor(random() * 0x7fffffff) + 1

			if (!this.paraIds.has(id) && !taken(id)) {
				this.paraIds.add(id)

				return id.toString(16).toUpperCase().padStart(8, "0")
			}
		}
	}
}

export interface DocxIdentity {
	// The document author name the app asked the user for (never filled in for them); undefined until given.
	author: string | undefined
	initials: string | undefined
	// The clock for dates written into the file (ms since the epoch).
	now: () => number
}

export interface DocxMediaInfo {
	readonly name?: string
	readonly contentType?: string
}

export interface DocxMediaEntry {
	readonly bytes: Uint8Array
	readonly info: DocxMediaInfo
}

// Bytes registered for commands (an image to insert); handles are positive integers. The store copies what
// it is given (a caller may reuse its buffers), into one array however many chunks a bridge streamed.
export class DocxMediaStore {
	private readonly entries = new Map<number, DocxMediaEntry>()
	private last = 0
	private total = 0
	// One picture at most (larger ones are refused, never downscaled), and all of them together.
	readonly maxBytes: number
	readonly maxTotal: number

	constructor(maxBytes: number = 25 * 1024 * 1024, maxTotal: number = 200 * 1024 * 1024) {
		this.maxBytes = maxBytes
		this.maxTotal = maxTotal
	}

	// The handle of the bytes, or undefined when they are over a limit.
	add(chunks: Uint8Array | readonly Uint8Array[], info: DocxMediaInfo = {}): number | undefined {
		const list = chunks instanceof Uint8Array ? [chunks] : chunks
		let size = 0

		for (const chunk of list) size += chunk.byteLength

		if (size > this.maxBytes || this.total + size > this.maxTotal) return undefined

		const bytes = new Uint8Array(size)
		let at = 0

		for (const chunk of list) {
			bytes.set(chunk, at)
			at += chunk.byteLength
		}

		this.total += size
		this.entries.set(++this.last, { bytes, info: { ...info } })

		return this.last
	}

	get(handle: number): DocxMediaEntry | undefined {
		return this.entries.get(handle)
	}

	bytes(handle: number): Uint8Array | undefined {
		return this.entries.get(handle)?.bytes
	}

	release(handle: number): void {
		const entry = this.entries.get(handle)

		if (entry === undefined) return

		this.total -= entry.bytes.byteLength
		this.entries.delete(handle)
	}

	// The last handle given out (handles ascend).
	get lastHandle(): number {
		return this.last
	}

	// Drops every entry the documents no longer use (a save knows which they are).
	// `used` must hold every handle the sessions can still bring back: those in their documents and those in
	// their undo history (an undo restores the picture). `through`: only handles given out up to it (later
	// ones may be on their way into a command).
	releaseUnused(used: ReadonlySet<number>, through = Infinity): void {
		for (const handle of [...this.entries.keys()]) if (handle <= through && !used.has(handle)) this.release(handle)
	}

	clear(): void {
		this.entries.clear()
		this.total = 0
	}
}

export interface DocxReviewState {
	// Edits are recorded as tracked changes.
	tracking: boolean
	// A save writes the switch into settings.xml (w:trackRevisions), as Word does; a host may keep it to the
	// session instead.
	persist: boolean
}

export type NewStoryKind = "footnote" | "endnote" | "comment" | "header" | "footer"

// A story the editor made: its kind, w:id (notes, comments) and the part the save writes it into (an existing
// part of the package, or one the save creates).
export interface NewStory {
	readonly kind: NewStoryKind
	readonly id: string | undefined
	readonly target: string
}

function isDocumentError(error: unknown): boolean {
	return error instanceof XmlError || error instanceof ZipError || error instanceof OpcError
}

// A part read for editing that exists but cannot be parsed makes the document view-only.
async function optionalXml(pkg: DocxPackage, kind: string, unreadable: string[]): Promise<XmlDocument | undefined> {
	const name = pkg.part(kind)

	if (name === undefined || !pkg.has(name)) return undefined

	try {
		return await pkg.xml(name)
	} catch (error) {
		if (!isDocumentError(error)) throw error

		unreadable.push(name)

		return undefined
	}
}

export interface EditContextParts {
	readonly store?: PropsStore
	readonly styles?: DocxStyles
	readonly numbering?: Numbering
	readonly resolver?: PropertyResolver
	// The document author name for what records one (comments, tracked changes), which the app asked the user
	// for (never filled in for them), and the clock for dates written into the file. Set once here; later
	// changes go to context.identity.
	readonly author?: string
	readonly clock?: () => number
	// The document's password to modify was given: its write protection does not make it view-only
	// (edit/protection.ts writeProtectionOf).
	readonly writeUnlocked?: boolean
	// The user stopped the document's protection (Word's Stop Protection, its password given where it has one):
	// no protection applies and the save writes it switched off (edit/protection.ts documentProtectionOf).
	readonly protectionUnlocked?: boolean
}

// Reads styles, numbering and theme for `model` (or reuses what a caller already parsed for layout).
export async function openDocxEditContext(pkg: DocxPackage, model: DocxModel, reuse: EditContextParts = {}): Promise<DocxEditContext> {
	const unreadable: string[] = []
	const store = reuse.store ?? new PropsStore()
	let styles = reuse.styles
	let numbering = reuse.numbering
	let resolver = reuse.resolver

	if (resolver === undefined) {
		const stylesXml = styles === undefined ? await optionalXml(pkg, "styles", unreadable) : undefined

		styles ??= stylesXml === undefined ? DocxStyles.empty() : parseStyles(stylesXml, store)

		if (numbering === undefined) {
			const numberingXml = await optionalXml(pkg, "numbering", unreadable)

			numbering = numberingXml === undefined ? undefined : parseNumbering(numberingXml, store, styles)
		}

		const themeXml = await optionalXml(pkg, "theme", unreadable)
		const theme = themeXml === undefined ? undefined : parseTheme(themeXml)

		resolver = new PropertyResolver({ styles, numbering, theme, settings: styleSettings(model.settings) })
	}

	const gate = gateReasons(pkg.facts, model, resolver.styles, resolver.numbering, {
		malformed: unreadable.length > 0 || store.malformed.length > 0
	}).filter(
		// A read-only document with ranges open to everyone opens editable within them (edit/protection.ts).
		reason =>
			!gateLifted(reason, reuse) &&
			(reason !== "protected" || pkg.facts.documentProtection?.edit !== "readOnly" || !readOnlyExceptions(model))
	)

	const context: DocxEditContext = {
		model,
		store,
		styles: resolver.styles,
		numbering: resolver.numbering,
		resolver,
		bases: new RunBases(store),
		gate,
		newLists: new Map(),
		newStyles: new Map(),
		newStyleWidths: new Map(),
		ids: new DocxIds(model.maxIds),
		identity: {
			author: reuse.author,
			initials: reuse.author === undefined ? undefined : authorInitials(reuse.author),
			now: reuse.clock ?? (() => Date.now())
		},
		media: new DocxMediaStore(),
		// Protection for tracked changes records every edit (ECMA-376 Part 1 §17.15.1.29); stopped, it leaves
		// tracking on for the user to turn off, as Word does.
		review: {
			tracking:
				model.settings.trackRevisions ||
				protectionMode(pkg.facts.documentProtection?.edit, pkg.facts.documentProtection?.enforced ?? false) === "trackedChanges",
			persist: true
		},
		newStories: new Map(),
		...(reuse.protectionUnlocked === true ? { protectionUnlocked: true } : {})
	}

	// Under protection the track switch is the session's: limited to ranges (or comments, or controls), Word tracks
	// that user's own edits; forced on by tracked changes protection, it is the protection's, not the file's
	// setting. The file's w:trackRevisions stays as it is.
	if (protectionOf(context).mode !== "none") context.review.persist = false

	// Which bindings map to a node is known before the first edit (a few small custom XML parts, only for a
	// document with bindings): controls bound to none are never kept alike.
	if (model.parts.some(partHasBindings)) await bindingsKnown(context)

	return context
}
