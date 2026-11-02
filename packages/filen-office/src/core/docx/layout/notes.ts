import { spliceAll } from "../../arrays"
import type { DocxModel } from "../model/document"
import { Ns } from "../model/namespaces"
import { partReader } from "../model/reader"
import type { NotePositionProps } from "../props/types"
import type { NoteNumbers, PageValues, StoryContext } from "./content"
import { numberText } from "./fields"
import type { Engine, FootnoteSink, PageFrame } from "./flow"
import { PageGraphic, Layer, PageOutput, Region, SourceFlag } from "./output"
import { EPSILON, points } from "./units"

// Note numbering (w:footnotePr / w:endnotePr in settings, overridden per section; where notes go is the
// document's alone: a section's w:pos "shall be ignored", ECMA-376 17.11.21 and 17.11.22) and the footnote area
// at the bottom of each page (or beneath its text).

export interface NoteSettings {
	readonly format: string
	readonly start: number
	// "continuous", "eachSect", "eachPage".
	readonly restart: string
	// "pageBottom", "beneathText", "sectEnd", "docEnd".
	readonly position: string
}

function readNotePr(model: DocxModel, node: number, endnote: boolean): NoteSettings {
	const out = { format: endnote ? "lowerRoman" : "decimal", start: 1, restart: "continuous", position: endnote ? "docEnd" : "pageBottom" }
	const document = model.settings.document

	if (document === undefined || node < 0) return out

	const reader = partReader(document)

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
		const value = reader.attr(child, Ns.W, "val")

		if (value === undefined) continue

		switch (document.localName(child)) {
			case "numFmt":
				out.format = value
				break
			case "numStart":
				out.start = Number.parseInt(value, 10) || 1
				break
			case "numRestart":
				out.restart = value
				break
			case "pos":
				out.position = value
				break
		}
	}

	return out
}

// Where the document's notes of a kind go, as its settings say.
export function documentNotePosition(model: DocxModel, endnote: boolean): string {
	return readNotePr(model, endnote ? model.settings.endnotePr : model.settings.footnotePr, endnote).position
}

function override(base: NoteSettings, section: NotePositionProps | undefined, position: string | undefined): NoteSettings {
	if (section === undefined && (position === undefined || position === base.position)) return base

	return {
		format: section?.numFormat ?? base.format,
		start: section?.numStart ?? base.start,
		restart: section?.numRestart ?? base.restart,
		position: position ?? base.position
	}
}

// Where notes go as edited, document-wide (undefined: the settings').
export interface NotePositions {
	readonly footnotePosition?: string | undefined
	readonly endnotePosition?: string | undefined
}

export interface NoteNumberingSnapshot {
	readonly footnotes: NoteSettings
	readonly endnotes: NoteSettings
	readonly footnoteNext: number
	readonly endnoteNext: number
}

export class NoteNumbering implements NoteNumbers {
	readonly documentFootnotes: NoteSettings
	readonly documentEndnotes: NoteSettings
	footnotes: NoteSettings
	endnotes: NoteSettings
	private footnoteNext: number
	private endnoteNext: number
	private readonly assigned = new Map<number, string>()
	// The mark text of each note story.
	readonly marks = new Map<number, string>()
	// Footnotes already on the page (numbering that restarts on each page counts from them).
	pageNotes: () => number = () => 0
	// References numbered in the paragraph being built.
	private paragraphRefs = 0

	constructor(model: DocxModel) {
		this.documentFootnotes = readNotePr(model, model.settings.footnotePr, false)
		this.documentEndnotes = readNotePr(model, model.settings.endnotePr, true)
		this.footnotes = this.documentFootnotes
		this.endnotes = this.documentEndnotes
		this.footnoteNext = this.footnotes.start
		this.endnoteNext = this.endnotes.start
	}

	startSection(
		footnotes: NotePositionProps | undefined,
		endnotes: NotePositionProps | undefined,
		first: boolean,
		positions?: NotePositions
	): void {
		this.footnotes = override(this.documentFootnotes, footnotes, positions?.footnotePosition)
		this.endnotes = override(this.documentEndnotes, endnotes, positions?.endnotePosition)

		if (first || this.footnotes.restart === "eachSect") this.footnoteNext = this.footnotes.start
		if (first || this.endnotes.restart === "eachSect") this.endnoteNext = this.endnotes.start
	}

	startPage(): void {
		if (this.footnotes.restart === "eachPage") this.footnoteNext = this.footnotes.start
	}

	// Numbering state to restart layout from.
	snapshot(): NoteNumberingSnapshot {
		return { footnotes: this.footnotes, endnotes: this.endnotes, footnoteNext: this.footnoteNext, endnoteNext: this.endnoteNext }
	}

	restore(snapshot: NoteNumberingSnapshot): void {
		this.footnotes = snapshot.footnotes
		this.endnotes = snapshot.endnotes
		this.footnoteNext = snapshot.footnoteNext
		this.endnoteNext = snapshot.endnoteNext
	}

	beginParagraph(): void {
		this.paragraphRefs = 0
	}

	// Numbers assigned to references of `part` items for which `keep` holds, to carry into a snapshot.
	assignedWhere(keep: (part: number, item: number) => boolean): [number, string][] {
		const out: [number, string][] = []

		for (const [key, text] of this.assigned) {
			const reference = Math.floor(key / 2)
			const part = Math.floor(reference / 0x4000000)

			if (keep(part, reference - part * 0x4000000)) out.push([key, text])
		}

		return out
	}

	// Forgets the numbers of references in parts for which `drop` holds (layout numbers them again), then
	// takes `kept` back.
	forgetAssigned(drop: (part: number) => boolean, kept: readonly (readonly [number, string])[]): void {
		for (const key of this.assigned.keys()) if (drop(Math.floor(key / 2 / 0x4000000))) this.assigned.delete(key)

		for (const [key, text] of kept) this.assigned.set(key, text)
	}

	reference(endnote: boolean, part: number, item: number, story: number): string {
		const key = (part * 0x4000000 + item) * 2 + (endnote ? 1 : 0)

		// Per-page numbering is decided where the paragraph is first built: after the notes already on its page.
		// Kept for the run like other numbers, so a paragraph built again (layout restarted at a page it waited
		// built for) shows what it showed.
		if (!endnote && this.footnotes.restart === "eachPage") {
			const index = this.paragraphRefs++
			let text = this.assigned.get(key)

			if (text === undefined) {
				text = numberText(this.footnotes.start + this.pageNotes() + index, this.footnotes.format)
				this.assigned.set(key, text)
			}

			this.marks.set(story, text)

			return text
		}

		let text = this.assigned.get(key)

		if (text === undefined) {
			const value = endnote ? this.endnoteNext++ : this.footnoteNext++

			text = numberText(value, endnote ? this.endnotes.format : this.footnotes.format)
			this.assigned.set(key, text)
		}

		// Kept from a snapshot, the number may differ from the one a later run gave the note.
		this.marks.set(story, text)

		return text
	}
}

interface LaidNote {
	readonly output: PageOutput
	readonly height: number
	// The page values and frame it was laid out with (a note continued on later pages keeps its first page's).
	readonly values: PageValues
	readonly frame: PageFrame | undefined
	// It shows the page number (a PAGE field).
	readonly numbered: boolean
	// The reference mark it shows.
	readonly mark: string
}

const NO_STORIES: readonly number[] = []
// mark() packs the references and the notes so far.
const MARK_SPAN = 0x10000

// A footnote area's state (FootnoteArea.save).
export interface FootnoteState {
	readonly notes: readonly PlacedNote[]
	readonly carry: readonly PlacedNote[]
	readonly left: number
	readonly width: number
	readonly reserved: number
	readonly splitAt: number
	readonly referenced: number
}

// A note to place on the page: its laid-out content from `from` (px into it; > 0 when continued).
export interface PlacedNote {
	readonly story: number
	readonly from: number
	readonly height: number
	// A note continued from an earlier page: the page values and frame it was laid out with there.
	readonly values?: PageValues | undefined
	readonly frame?: PageFrame | undefined
	// Left for the next page: the reference mark it shows (numbered where its reference was built).
	readonly mark?: string | undefined
}

// The footnote area of the page being laid out.
export class FootnoteArea implements FootnoteSink {
	reserved = 0
	// The index of the last note, started on this page but too long to end here, or -1.
	private splitAt = -1
	private readonly engine: Engine
	private readonly notes: PlacedNote[] = []
	private readonly cache = new Map<number, LaidNote>()
	private carry: PlacedNote[] = []
	// The notes referenced on the page's lines so far (each where its reference is, wherever the note goes).
	private readonly referencedStories: number[] = []
	private separatorStory = -1
	private continuationStory = -1
	private width = 0
	private left = 0
	// The page's body area: no note line taller than it fits any page.
	private areaTop = 0
	private areaBottom = Infinity
	private values: PageValues = { page: 1, pageFormat: undefined, numPages: 1, sectionPages: 1 }
	private frame: PageFrame | undefined = undefined
	private separatorHeight = 0
	private continuationHeight = 0

	constructor(engine: Engine) {
		this.engine = engine
		this.findSeparators()
	}

	// The separator notes: those settings name, else the first of each type. A notes part the editor made
	// brings its own (looked for again at each page while none is known).
	private findSeparators(): void {
		const model = this.engine.model

		for (const id of model.settings.footnoteSeparators) {
			const story = model.footnotes.get(id)

			if (story?.noteType === "separator") this.separatorStory = story.index
			else if (story?.noteType === "continuationSeparator") this.continuationStory = story.index
		}

		for (const story of model.footnotes.values()) {
			if (story.noteType === "separator" && this.separatorStory < 0) this.separatorStory = story.index
			if (story.noteType === "continuationSeparator" && this.continuationStory < 0) this.continuationStory = story.index
		}
	}

	get carried(): boolean {
		return this.carry.length > 0
	}

	// Notes continued onto the next page, to restart layout there.
	get carriedNotes(): readonly PlacedNote[] {
		return this.carry.slice()
	}

	set carriedNotes(notes: readonly PlacedNote[]) {
		this.carry = notes.slice()
	}

	// The notes referenced on the page, once each.
	get referenced(): readonly number[] {
		return this.referencedStories.length === 0 ? NO_STORIES : [...new Set(this.referencedStories)]
	}

	// Notes that start on this page.
	get count(): number {
		let count = 0

		for (const note of this.notes) if (note.from === 0) count++

		return count
	}

	// Layout restarts: notes are laid out again as they now read and are numbered (one laid out and left for the
	// next page, or continued there, stays in the cache meanwhile).
	restart(): void {
		this.cache.clear()
	}

	// A new page: the area spans [left, left + width); notes continued from the last page come first.
	startPage(left: number, width: number, values: PageValues, frame: PageFrame, top = 0, bottom = Infinity): void {
		this.areaTop = top
		this.areaBottom = bottom

		if (Math.abs(width - this.width) > EPSILON) this.cache.clear()

		// A note laid out on the page before and left for this one (whole) shows this page's number; one continued
		// here (part of it shown there) keeps the layout it began with.
		if (values.page !== this.values.page)
			for (const [story, laid] of this.cache)
				if (laid.numbered && !this.carry.some(note => note.story === story && note.from > 0)) this.cache.delete(story)

		this.width = width
		this.values = values
		this.frame = frame
		this.referencedStories.length = 0

		if (this.separatorStory < 0 && this.continuationStory < 0) this.findSeparators()

		this.separatorHeight = this.separatorStory < 0 ? points(12) : this.laid(this.separatorStory).height
		this.continuationHeight = this.continuationStory < 0 ? points(12) : this.laid(this.continuationStory).height
		this.startColumn(left, width)
	}

	// A new column with notes of its own, spanning [left, left + width); notes continued from the column
	// before come first.
	startColumn(left: number, width: number): void {
		if (Math.abs(width - this.width) > EPSILON) {
			this.cache.clear()
			this.width = width
			this.separatorHeight = this.separatorStory < 0 ? points(12) : this.laid(this.separatorStory).height
			this.continuationHeight = this.continuationStory < 0 ? points(12) : this.laid(this.continuationStory).height
		}

		this.left = left
		this.notes.length = 0
		this.reserved = 0

		for (const note of this.carry) this.notes.push(note)

		this.carry = []
		this.splitAt = -1
		this.reserved = this.notes.length === 0 ? 0 : this.continuationHeight + this.notes.reduce((sum, note) => sum + note.height, 0)
	}

	get split(): boolean {
		return this.splitAt >= 0
	}

	// The whole state, to lay a part of the page out again from here.
	save(): FootnoteState {
		return {
			notes: this.notes.slice(),
			carry: this.carry.slice(),
			left: this.left,
			width: this.width,
			reserved: this.reserved,
			splitAt: this.splitAt,
			referenced: this.referencedStories.length
		}
	}

	load(state: FootnoteState): void {
		if (Math.abs(state.width - this.width) > EPSILON) this.startColumn(state.left, state.width)

		spliceAll(this.notes, 0, this.notes.length, state.notes)
		this.carry = state.carry.slice()
		this.left = state.left
		this.reserved = state.reserved
		this.splitAt = state.splitAt
		this.referencedStories.length = Math.min(this.referencedStories.length, state.referenced)
	}

	mark(): number {
		return this.referencedStories.length * MARK_SPAN + this.notes.length
	}

	rollback(mark: number): void {
		const references = Math.floor(mark / MARK_SPAN)
		const notes = mark - references * MARK_SPAN

		if (references < this.referencedStories.length) this.referencedStories.length = references

		if (notes >= this.notes.length) return

		this.notes.length = notes

		if (this.splitAt >= notes) this.splitAt = -1

		this.reserved = this.notes.length === 0 ? 0 : this.separator() + this.notes.reduce((sum, note) => sum + note.height, 0)
	}

	private separator(): number {
		return (this.notes[0]?.from ?? 0) > 0 ? this.continuationHeight : this.separatorHeight
	}

	add(story: number, lineBottom: number, limit: number, force: boolean): boolean {
		this.referencedStories.push(story)

		if (this.notes.some(note => note.story === story && note.from === 0)) return true

		if (this.splitAt >= 0) return force

		const laid = this.laid(story)
		const before = this.notes.length === 0 ? this.separatorHeight : this.reserved
		const needed = before + laid.height

		if (!force && lineBottom + needed > limit + EPSILON) {
			// A note too long for the room left starts here when its first line fits; the rest continues on the
			// next page, and the page takes no more text.
			const text = laid.output.text

			if (text.lineCount === 0 || lineBottom + before + text.lineTop(0) + text.lineHeight(0) > limit + EPSILON) return false

			this.splitAt = this.notes.length
			this.notes.push({ story, from: 0, height: laid.height })
			this.reserved = limit - lineBottom

			return true
		}

		this.notes.push({ story, from: 0, height: laid.height })
		this.reserved = needed

		return true
	}

	// `from`: a note continued from an earlier page, laid out as it was there (layout restarted since).
	private laid(story: number, from?: PlacedNote): LaidNote {
		let laid = this.cache.get(story)

		if (laid === undefined) {
			const values = from?.values ?? this.values
			const frame = from?.frame ?? this.frame
			const engine = this.engine
			const root = engine.model.stories[story]
			const part = root === undefined ? undefined : engine.model.parts[root.part]
			const output = new PageOutput()
			const mark = engine.notes.marks.get(story) ?? ""
			let height = 0

			if (root !== undefined && part !== undefined && frame !== undefined) {
				const context: StoryContext = {
					part,
					story,
					counters: undefined,
					noteMark: mark,
					breaksAsLines: true,
					recount: false
				}

				const trailing = engine.tuning.noteTrailingSpace
				const separator = root.noteType === "separator" || root.noteType === "continuationSeparator"

				height = engine.layoutBox(
					context,
					Region.FOOTNOTE,
					output,
					values,
					frame,
					0,
					0,
					this.width,
					trailing === "all" || (trailing === "notes" && !separator)
				)
			}

			let numbered = false

			for (let source = 0; source < output.sourceCount && !numbered; source++)
				numbered = (output.sourceFlags(source) & SourceFlag.PAGE_FIELDS) !== 0

			laid = { output, height, values, frame, numbered, mark }
			this.cache.set(story, laid)

			// Laid out with stand-ins for fonts still loading: the page is laid out again once they loaded (they
			// may arrive before it closes).
			if (engine.styles.hasMissing) engine.standIns = true
		}

		return laid
	}

	// Draws the notes at the bottom of the text area (bottom edge `bottom`); notes that do not fit continue
	// on the next page (or column). Returns the top of the notes, `bottom` without any.
	close(page: PageOutput, bottom: number, contentBottom: number): number {
		if (this.notes.length === 0) return bottom

		// Beneath the text, the notes follow its last line (ST_FtnPos beneathText); else they end at the bottom.
		let y =
			this.engine.notes.footnotes.position === "beneathText"
				? Math.min(contentBottom, bottom)
				: Math.max(bottom - this.reserved, Math.min(contentBottom, bottom))
		const top = y
		const continued = (this.notes[0]?.from ?? 0) > 0
		const separator = continued ? this.continuationStory : this.separatorStory

		if (separator >= 0) page.append(this.laid(separator).output, this.left, y)
		else
			page.addGraphic(
				PageGraphic.NOTE_SEPARATOR,
				0,
				Layer.TEXT,
				this.left,
				y + points(6),
				continued ? this.width : Math.min(this.width, 192),
				1
			)

		y += continued ? this.continuationHeight : this.separatorHeight

		for (const note of this.notes) {
			const laid = this.laid(note.story, note.from > 0 ? note : undefined)
			const room = bottom - y
			const rest = laid.height - note.from

			if (rest <= room + EPSILON) {
				page.append(laid.output, this.left, y - note.from, note.from, Infinity)
				y += rest
				this.cache.delete(note.story)

				continue
			}

			// Split at a line boundary: lines starting above the area's bottom stay.
			const fits = this.lineCut(laid.output, note.from, note.from + room)
			const cut =
				fits <= note.from && note === this.notes[0] ? this.tallLineEnd(laid.output, note.from, laid.height, continued) : fits

			if (cut > note.from) page.append(laid.output, this.left, y - note.from, note.from, cut)

			y = bottom

			if (cut >= laid.height - EPSILON) {
				this.cache.delete(note.story)

				continue
			}

			this.carry.push({
				story: note.story,
				from: cut,
				height: laid.height - cut,
				values: laid.values,
				frame: laid.frame,
				mark: laid.mark
			})
		}

		return top
	}

	// A note's line from `from` on too tall for any page (with the separator above it, taller than the body
	// area) is shown anyway, overflowing: no page would take it otherwise. Where it ends (in the note's own
	// coordinates), or `from` when the line fits a page.
	private tallLineEnd(output: PageOutput, from: number, height: number, continued: boolean): number {
		const text = output.text

		for (let line = 0; line < text.lineCount; line++) {
			const top = text.lineTop(line)

			if (top < from - EPSILON) continue

			const separator = continued ? this.continuationHeight : this.separatorHeight
			const tall = separator + text.lineHeight(line) > this.areaBottom - this.areaTop + EPSILON

			return tall ? Math.max(from + EPSILON, Math.min(height, top + text.lineHeight(line))) : from
		}

		return from
	}

	// The top of the first line that does not end by `limit` (in the note's own coordinates).
	private lineCut(output: PageOutput, from: number, limit: number): number {
		const text = output.text
		let cut = limit

		for (let line = 0; line < text.lineCount; line++) {
			const top = text.lineTop(line)

			if (top < from - EPSILON) continue

			if (top + text.lineHeight(line) > limit + EPSILON) {
				cut = top

				break
			}
		}

		return Math.max(from, cut)
	}
}
