import type { Relationships } from "../../opc/index"
import { NodeKind, sliceClock, type Slicing } from "../../xml/index"
import { Column, StringTable } from "./columns"
import { readDrawing, readVml, type DrawingInfo, type VmlInfo, type VmlKind } from "./drawings"
import { FieldCharType, Item, Revision, RevisionFlag, SdtLevel } from "./kinds"
import { El, Ns, understandsChoice } from "./namespaces"
import { StoryPart, type PartItems, type PartTables } from "./part"
import { afterSubtree, type PartReader } from "./reader"
import { noteType, type Story, type StoryKind } from "./story"

// Deeper nesting than this (sdt in customXml in table in text box ...) is kept as one opaque item, so a
// hostile document cannot exhaust the stack.
const MAX_DEPTH = 192

// Where an element sits, which decides what its children may be.
const Ctx = { Block: 0, Inline: 1, Run: 2, Rows: 3, Cells: 4 } as const
type Ctx = (typeof Ctx)[keyof typeof Ctx]

const SDT_LEVEL_OF_CTX: readonly SdtLevel[] = [SdtLevel.Block, SdtLevel.Run, SdtLevel.Run, SdtLevel.Row, SdtLevel.Cell]

export interface SectionSeed {
	readonly part: number
	// The paragraph whose pPr carries the sectPr, or the body's final SectionProperties item.
	readonly item: number
	readonly node: number
}

// Tracked changes inside equations (see mathRevisionIds).
const MATH_CHANGES: ReadonlySet<string> = new Set(["ins", "del", "moveFrom", "moveTo"])

export interface MaxIds {
	docPr: number
	bookmark: number
	comment: number
	revision: number
	footnote: number
	endnote: number
	permission: number
}

export interface BuildCounts {
	proofErrors: number
	ignoredSectionProperties: number
	unbalancedFieldEnds: number
	unterminatedFields: number
	depthLimited: number
	// Elements whose start tag could not be read (kept as opaque items or read without attributes).
	malformed: number
}

// Comment anchors across parts: ranges sit in a story part, the comment itself in comments.xml.
export class CommentAnchors {
	readonly ids = new Map<string, number>()
	readonly startPart = new Column()
	readonly startItem = new Column()
	readonly endPart = new Column()
	readonly endItem = new Column()
	readonly referencePart = new Column()
	readonly referenceItem = new Column()

	row(id: string): number {
		let row = this.ids.get(id)

		if (row === undefined) {
			row = this.startPart.push(-1)
			this.startItem.push(-1)
			this.endPart.push(-1)
			this.endItem.push(-1)
			this.referencePart.push(-1)
			this.referenceItem.push(-1)
			this.ids.set(id, row)
		}

		return row
	}

	get count(): number {
		return this.startPart.length
	}
}

// State shared by every part of one model.
export class ModelTables {
	readonly strings = new StringTable()
	readonly stories: Story[] = []
	readonly drawings: DrawingInfo[] = []
	readonly vml: VmlInfo[] = []
	readonly sections: SectionSeed[] = []
	readonly anchors = new CommentAnchors()
	readonly maxIds: MaxIds = { docPr: 0, bookmark: -1, comment: -1, revision: -1, footnote: -1, endnote: -1, permission: -1 }
	readonly counts: BuildCounts = {
		proofErrors: 0,
		ignoredSectionProperties: 0,
		unbalancedFieldEnds: 0,
		unterminatedFields: 0,
		depthLimited: 0,
		malformed: 0
	}
}

const MARK_REVISIONS: Partial<Record<number, readonly [Revision, number]>> = {
	[El.Ins]: [Revision.ParagraphMarkInsertion, RevisionFlag.Inserted],
	[El.Del]: [Revision.ParagraphMarkDeletion, RevisionFlag.Deleted],
	[El.MoveFrom]: [Revision.ParagraphMarkMoveFrom, RevisionFlag.MovedFrom],
	[El.MoveTo]: [Revision.ParagraphMarkMoveTo, RevisionFlag.MovedTo]
}

const PLACEHOLDER_DRAWING = null as unknown as DrawingInfo
const PLACEHOLDER_VML = null as unknown as VmlInfo

// Builds one part's item stream in a single pass over its element tree. Every item is a distinct element,
// so the element count bounds the item count and the item arrays are allocated once.
class PartBuilder {
	private readonly reader: PartReader
	private readonly document: PartReader["document"]
	private readonly shared: ModelTables
	private readonly partIndex: number
	private readonly kinds: Uint8Array
	private readonly nodes: Int32Array
	private readonly ends: Int32Array
	private readonly parents: Int32Array
	private readonly aux: Int32Array
	private count = 0
	private story = -1
	private storyKind: StoryKind = "body"
	private tableDepth = 0
	private fieldStack: number[] = []

	private readonly paragraph = {
		item: new Column(64),
		pPr: new Column(64),
		style: new Column(64),
		numPr: new Column(64),
		sectPr: new Column(64),
		markRPr: new Column(64),
		pPrChange: new Column(64),
		markRevision: new Column(64),
		markRevisionRow: new Column(64)
	}
	private readonly run = { item: new Column(128), rPr: new Column(128), style: new Column(128), rPrChange: new Column(128) }
	private readonly table = { item: new Column(), tblPr: new Column(), tblGrid: new Column(), style: new Column(), depth: new Column() }
	private readonly row = {
		item: new Column(),
		trPr: new Column(),
		tblPrEx: new Column(),
		revision: new Column(),
		revisionRow: new Column()
	}
	private readonly cell = { item: new Column(), tcPr: new Column(), revision: new Column(), revisionRow: new Column() }
	private readonly sdt = { item: new Column(), sdtPr: new Column(), sdtEndPr: new Column(), content: new Column(), level: new Column() }
	private readonly field = {
		begin: new Column(),
		separate: new Column(),
		end: new Column(),
		parent: new Column(),
		simple: new Column(),
		instruction: new Column(),
		lastInstruction: new Column()
	}
	private readonly bookmark = { start: new Column(), end: new Column(), ids: new Map<string, number>() }
	private readonly revision = {
		kind: new Column(),
		item: new Column(),
		node: new Column(),
		id: new Column(),
		author: new Column(),
		date: new Column()
	}
	private readonly alternate = {
		item: new Column(),
		selected: new Column(),
		fallback: new Column(),
		firstBranch: new Column(),
		branchCount: new Column()
	}
	private readonly branches = new Column()

	constructor(reader: PartReader, shared: ModelTables, partIndex: number) {
		this.reader = reader
		this.document = reader.document
		this.shared = shared
		this.partIndex = partIndex

		const capacity = reader.document.count

		this.kinds = new Uint8Array(capacity)
		this.nodes = new Int32Array(capacity)
		this.ends = new Int32Array(capacity)
		this.parents = new Int32Array(capacity)
		this.aux = new Int32Array(capacity)
	}

	// The build, yielding after each top-level block of a story part.
	*steps(name: string, relationships: Relationships): Generator<void, StoryPart> {
		const document = this.document
		const root = document.documentElement()

		switch (this.reader.code(root)) {
			case El.Document:
				for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
					const code = this.reader.code(child)

					if (code === El.Body) {
						yield* this.storySteps(child, -1, Item.Body, "body", undefined)
					} else if (code !== El.Background) {
						this.leaf(Item.Opaque, child, -1, 0)
					}
				}

				break
			case El.Header:
				yield* this.storySteps(root, -1, Item.Header, "header", undefined)

				break
			case El.Footer:
				yield* this.storySteps(root, -1, Item.Footer, "footer", undefined)

				break
			case El.Footnotes:
			case El.Endnotes: {
				const kind: StoryKind = this.reader.code(root) === El.Footnotes ? "footnote" : "endnote"
				const noteCode = kind === "footnote" ? El.Footnote : El.Endnote

				for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
					if (this.reader.code(child) === noteCode) {
						const id = this.reader.int(child, Ns.W, "id", -1)

						if (kind === "footnote") this.shared.maxIds.footnote = Math.max(this.shared.maxIds.footnote, id)
						else this.shared.maxIds.endnote = Math.max(this.shared.maxIds.endnote, id)

						yield* this.storySteps(child, -1, Item.Note, kind, this.reader.attr(child, Ns.W, "type"))
					} else {
						this.leaf(Item.Opaque, child, -1, 0)
					}
				}

				break
			}
			case El.Comments:
				for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
					if (this.reader.code(child) === El.Comment) {
						this.shared.maxIds.comment = Math.max(this.shared.maxIds.comment, this.reader.int(child, Ns.W, "id", -1))
						yield* this.storySteps(child, -1, Item.Comment, "comment", undefined)
					} else {
						this.leaf(Item.Opaque, child, -1, 0)
					}
				}

				break
		}

		this.shared.counts.malformed += this.reader.malformedNodes.size

		return new StoryPart(this.partIndex, name, this.reader, relationships, this.items(), this.tables())
	}

	private items(): PartItems {
		const count = this.count

		return {
			count,
			kinds: this.kinds.slice(0, count),
			nodes: this.nodes.slice(0, count),
			ends: this.ends.slice(0, count),
			parents: this.parents.slice(0, count),
			aux: this.aux.slice(0, count)
		}
	}

	private tables(): PartTables {
		const p = this.paragraph
		const r = this.run
		const t = this.table
		const f = this.field

		return {
			paragraphs: {
				count: p.item.length,
				item: p.item.trim(),
				pPr: p.pPr.trim(),
				style: p.style.trim(),
				numPr: p.numPr.trim(),
				sectPr: p.sectPr.trim(),
				markRPr: p.markRPr.trim(),
				pPrChange: p.pPrChange.trim(),
				markRevision: p.markRevision.trim(),
				markRevisionRow: p.markRevisionRow.trim()
			},
			runs: { count: r.item.length, item: r.item.trim(), rPr: r.rPr.trim(), style: r.style.trim(), rPrChange: r.rPrChange.trim() },
			tables: {
				count: t.item.length,
				item: t.item.trim(),
				tblPr: t.tblPr.trim(),
				tblGrid: t.tblGrid.trim(),
				style: t.style.trim(),
				depth: t.depth.trim()
			},
			rows: {
				count: this.row.item.length,
				item: this.row.item.trim(),
				trPr: this.row.trPr.trim(),
				tblPrEx: this.row.tblPrEx.trim(),
				revision: this.row.revision.trim(),
				revisionRow: this.row.revisionRow.trim()
			},
			cells: {
				count: this.cell.item.length,
				item: this.cell.item.trim(),
				tcPr: this.cell.tcPr.trim(),
				revision: this.cell.revision.trim(),
				revisionRow: this.cell.revisionRow.trim()
			},
			sdts: {
				count: this.sdt.item.length,
				item: this.sdt.item.trim(),
				sdtPr: this.sdt.sdtPr.trim(),
				sdtEndPr: this.sdt.sdtEndPr.trim(),
				content: this.sdt.content.trim(),
				level: this.sdt.level.trim()
			},
			fields: {
				count: f.begin.length,
				begin: f.begin.trim(),
				separate: f.separate.trim(),
				end: f.end.trim(),
				parent: f.parent.trim(),
				simple: Uint8Array.from(f.simple.trim()),
				instruction: f.instruction.trim()
			},
			bookmarks: {
				count: this.bookmark.start.length,
				start: this.bookmark.start.trim(),
				end: this.bookmark.end.trim(),
				ids: this.bookmark.ids
			},
			revisions: {
				count: this.revision.kind.length,
				kind: this.revision.kind.trim(),
				item: this.revision.item.trim(),
				node: this.revision.node.trim(),
				id: this.revision.id.trim(),
				author: this.revision.author.trim(),
				date: this.revision.date.trim()
			},
			alternates: {
				count: this.alternate.item.length,
				item: this.alternate.item.trim(),
				selected: this.alternate.selected.trim(),
				fallback: this.alternate.fallback.trim(),
				firstBranch: this.alternate.firstBranch.trim(),
				branchCount: this.alternate.branchCount.trim(),
				branches: this.branches.trim()
			}
		}
	}

	private open(kind: Item, node: number, parent: number, aux: number): number {
		const item = this.count++

		this.kinds[item] = kind
		this.nodes[item] = node
		this.parents[item] = parent
		this.aux[item] = aux
		this.ends[item] = item + 1

		return item
	}

	private close(item: number): void {
		this.ends[item] = this.count
	}

	private leaf(kind: Item, node: number, parent: number, aux: number): number {
		return this.open(kind, node, parent, aux)
	}

	private setAux(item: number, aux: number): void {
		this.aux[item] = aux
	}

	private storyContainer(
		node: number,
		parent: number,
		kind: Item,
		storyKind: StoryKind,
		type: string | undefined,
		depth: number = 1
	): void {
		drain(this.storySteps(node, parent, kind, storyKind, type, depth))
	}

	// A story's blocks, yielding after each.
	private *storySteps(
		node: number,
		parent: number,
		kind: Item,
		storyKind: StoryKind,
		type: string | undefined,
		depth: number = 1
	): Generator<void, void> {
		const stories = this.shared.stories
		const index = stories.length
		const item = this.open(kind, node, parent, index)
		const reader = this.reader
		const isNote = storyKind === "footnote" || storyKind === "endnote"

		stories.push({
			index,
			kind: storyKind,
			part: this.partIndex,
			item,
			id: isNote || storyKind === "comment" ? reader.attr(node, Ns.W, "id") : undefined,
			noteType: isNote ? noteType(type) : undefined,
			parent: storyKind === "textbox" ? this.story : -1,
			owner: storyKind === "textbox" ? parent : -1
		})

		const savedStory = this.story
		const savedKind = this.storyKind
		const savedFields = this.fieldStack
		const savedTableDepth = this.tableDepth

		this.story = index
		this.storyKind = storyKind
		this.fieldStack = []
		this.tableDepth = 0

		const document = this.document
		const top = storyKind === "body"

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			// A table yields after each row too (content() would build it whole).
			if (depth <= MAX_DEPTH && reader.wellFormed(child) && reader.code(child) === El.Tbl) yield* this.tableSteps(child, item, depth)
			else this.content(child, item, depth, Ctx.Block, top)

			yield
		}

		this.shared.counts.unterminatedFields += this.fieldStack.length
		this.story = savedStory
		this.storyKind = savedKind
		this.fieldStack = savedFields
		this.tableDepth = savedTableDepth
		this.close(item)
	}

	private children(container: number, parent: number, depth: number, ctx: Ctx, top: boolean): void {
		const document = this.document

		for (let child = document.firstChildElement(container); child >= 0; child = document.nextSiblingElement(child)) {
			this.content(child, parent, depth, ctx, top)
		}
	}

	private content(node: number, parent: number, depth: number, ctx: Ctx, top: boolean): void {
		if (depth > MAX_DEPTH) {
			this.shared.counts.depthLimited++
			this.leaf(Item.Opaque, node, parent, 0)

			return
		}

		if (!this.reader.wellFormed(node)) {
			this.leaf(Item.Opaque, node, parent, 0)

			return
		}

		const code = this.reader.code(node)

		switch (code) {
			case El.BookmarkStart:
			case El.BookmarkEnd:
			case El.CommentRangeStart:
			case El.CommentRangeEnd:
			case El.MoveFromRangeStart:
			case El.MoveFromRangeEnd:
			case El.MoveToRangeStart:
			case El.MoveToRangeEnd:
			case El.PermStart:
			case El.PermEnd:
			case El.CustomXmlRangeMarker:
				this.marker(node, parent, code)

				return
			case El.Sdt:
				this.sdtElement(node, parent, depth, SDT_LEVEL_OF_CTX[ctx] ?? SdtLevel.Block, top)

				return
			case El.CustomXml:
				this.wrapper(Item.CustomXml, node, parent, depth, ctx === Ctx.Run ? Ctx.Inline : ctx, top, El.CustomXmlPr)

				return
			case El.AlternateContent:
				this.alternateContent(node, parent, depth, ctx, top)

				return
			case El.Ins:
				this.revisionWrapper(Item.Insertion, Revision.Insertion, node, parent, depth, ctx, top)

				return
			case El.Del:
				this.revisionWrapper(Item.Deletion, Revision.Deletion, node, parent, depth, ctx, top)

				return
			case El.MoveFrom:
				this.revisionWrapper(Item.MoveFrom, Revision.MoveFrom, node, parent, depth, ctx, top)

				return
			case El.MoveTo:
				this.revisionWrapper(Item.MoveTo, Revision.MoveTo, node, parent, depth, ctx, top)

				return
			case El.ProofErr:
				this.shared.counts.proofErrors++

				return
			case El.OMathPara:
				this.leaf(Item.MathParagraph, node, parent, 0)
				this.mathRevisionIds(node)

				return
			case El.OMath:
				this.leaf(Item.Math, node, parent, 0)
				this.mathRevisionIds(node)

				return
		}

		switch (ctx) {
			case Ctx.Block:
				switch (code) {
					case El.P:
						this.paragraphElement(node, parent, depth, top)

						return
					case El.Tbl:
						this.tableElement(node, parent, depth)

						return
					case El.SectPr: {
						const item = this.leaf(Item.SectionProperties, node, parent, 0)

						this.childRevision(node, El.SectPrChange, Revision.SectionProperties, item)

						if (top && this.storyKind === "body") {
							this.shared.sections.push({ part: this.partIndex, item, node })
						} else {
							this.shared.counts.ignoredSectionProperties++
						}

						return
					}
					case El.AltChunk:
						this.leaf(Item.AltChunk, node, parent, 0)

						return
				}

				break
			case Ctx.Inline:
				switch (code) {
					case El.R:
						this.runElement(node, parent, depth)

						return
					case El.Hyperlink:
						this.wrapper(Item.Hyperlink, node, parent, depth, Ctx.Inline, false, El.Unknown)

						return
					case El.FldSimple:
						this.simpleField(node, parent, depth)

						return
					case El.SmartTag:
						this.wrapper(Item.SmartTag, node, parent, depth, Ctx.Inline, false, El.SmartTagPr)

						return
					case El.Dir:
					case El.Bdo:
						this.bidi(node, parent, depth)

						return
				}

				break
			case Ctx.Run:
				if (this.runContent(node, parent, depth, code)) return

				break
			case Ctx.Rows:
				if (code === El.Tr) {
					this.rowElement(node, parent, depth)

					return
				}

				break
			case Ctx.Cells:
				if (code === El.Tc) {
					this.cellElement(node, parent, depth)

					return
				}

				break
		}

		this.leaf(Item.Opaque, node, parent, 0)
	}

	private runContent(node: number, parent: number, depth: number, code: El): boolean {
		const reader = this.reader

		switch (code) {
			case El.T:
				this.leaf(Item.Text, node, parent, this.preserve(node))

				return true
			case El.DelText:
				this.leaf(Item.DeletedText, node, parent, this.preserve(node))

				return true
			case El.InstrText:
				this.instruction(Item.InstrText, node, parent)

				return true
			case El.DelInstrText:
				this.instruction(Item.DeletedInstrText, node, parent)

				return true
			case El.Tab:
				this.leaf(Item.Tab, node, parent, 0)

				return true
			case El.Br:
				this.leaf(Item.Break, node, parent, this.breakAux(node))

				return true
			case El.Cr:
				this.leaf(Item.CarriageReturn, node, parent, 0)

				return true
			case El.LastRenderedPageBreak:
				this.leaf(Item.LastRenderedPageBreak, node, parent, 0)

				return true
			case El.Sym:
				this.leaf(Item.Symbol, node, parent, reader.hex(node, Ns.W, "char", -1))

				return true
			case El.SoftHyphen:
				this.leaf(Item.SoftHyphen, node, parent, 0)

				return true
			case El.NoBreakHyphen:
				this.leaf(Item.NoBreakHyphen, node, parent, 0)

				return true
			case El.Ptab:
				this.leaf(Item.PositionalTab, node, parent, 0)

				return true
			case El.FldChar:
				this.fieldChar(node, parent)

				return true
			case El.FootnoteReference: {
				const id = reader.int(node, Ns.W, "id", -1)

				this.leaf(Item.FootnoteReference, node, parent, id)
				// A new note never takes an id a reference uses, even one whose note is missing.
				this.shared.maxIds.footnote = Math.max(this.shared.maxIds.footnote, id)

				return true
			}
			case El.EndnoteReference: {
				const id = reader.int(node, Ns.W, "id", -1)

				this.leaf(Item.EndnoteReference, node, parent, id)
				this.shared.maxIds.endnote = Math.max(this.shared.maxIds.endnote, id)

				return true
			}
			case El.FootnoteRef:
				this.leaf(Item.FootnoteMark, node, parent, 0)

				return true
			case El.EndnoteRef:
				this.leaf(Item.EndnoteMark, node, parent, 0)

				return true
			case El.Separator:
				this.leaf(Item.Separator, node, parent, 0)

				return true
			case El.ContinuationSeparator:
				this.leaf(Item.ContinuationSeparator, node, parent, 0)

				return true
			case El.CommentReference: {
				const item = this.leaf(Item.CommentReference, node, parent, -1)
				const id = reader.attr(node, Ns.W, "id")

				// A new comment never takes an id an anchor or reference uses, even one whose comment is missing.
				this.shared.maxIds.comment = Math.max(this.shared.maxIds.comment, reader.int(node, Ns.W, "id", -1))

				if (id !== undefined) {
					const anchors = this.shared.anchors
					const row = anchors.row(id)

					anchors.referencePart.set(row, this.partIndex)
					anchors.referenceItem.set(row, item)
					this.setAux(item, row)
				}

				return true
			}
			case El.AnnotationRef:
				this.leaf(Item.AnnotationMark, node, parent, 0)

				return true
			case El.Drawing:
				this.drawing(node, parent, depth)

				return true
			case El.Pict:
				this.vml(node, parent, depth, "picture")

				return true
			case El.Object:
				this.vml(node, parent, depth, "object")

				return true
			case El.Ruby:
				this.ruby(node, parent, depth)

				return true
			case El.PgNum:
				this.leaf(Item.PageNumber, node, parent, 0)

				return true
			case El.DayShort:
			case El.MonthShort:
			case El.YearShort:
			case El.DayLong:
			case El.MonthLong:
			case El.YearLong:
				this.leaf(Item.DateTimePart, node, parent, code)

				return true
			case El.ContentPart:
			case El.W14ContentPart:
				this.leaf(Item.ContentPart, node, parent, 0)

				return true
		}

		return false
	}

	private preserve(node: number): number {
		return this.reader.equals(node, Ns.Xml, "space", "preserve") ? 1 : 0
	}

	// Instruction text joins the chain of the innermost field still reading its instruction; the aux slot
	// holds the preserve flag and the next item of the chain.
	private instruction(kind: Item, node: number, parent: number): void {
		const item = this.leaf(kind, node, parent, this.preserve(node))
		const stack = this.fieldStack
		const fields = this.field
		const field = stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1

		if (field < 0 || fields.simple.get(field) === 1 || fields.separate.get(field) >= 0) return

		const last = fields.lastInstruction.get(field)

		if (last < 0) fields.instruction.set(field, item)
		else this.aux[last] = (this.aux[last] ?? 0) | ((item + 1) << 1)

		fields.lastInstruction.set(field, item)
	}

	private breakAux(node: number): number {
		const reader = this.reader
		const type = reader.equals(node, Ns.W, "type", "page") ? 1 : reader.equals(node, Ns.W, "type", "column") ? 2 : 0
		const clear = reader.equals(node, Ns.W, "clear", "left")
			? 1
			: reader.equals(node, Ns.W, "clear", "right")
				? 2
				: reader.equals(node, Ns.W, "clear", "all")
					? 3
					: 0

		return type | (clear << 2)
	}

	private fieldChar(node: number, parent: number): void {
		const reader = this.reader
		const type = reader.equals(node, Ns.W, "fldCharType", "begin")
			? FieldCharType.Begin
			: reader.equals(node, Ns.W, "fldCharType", "separate")
				? FieldCharType.Separate
				: reader.equals(node, Ns.W, "fldCharType", "end")
					? FieldCharType.End
					: FieldCharType.Unknown
		const flags = (reader.flag(node, Ns.W, "dirty") ? 4 : 0) | (reader.flag(node, Ns.W, "fldLock") ? 8 : 0)
		const item = this.leaf(Item.FieldChar, node, parent, type | flags)
		const stack = this.fieldStack
		const fields = this.field
		let field = -1

		if (type === FieldCharType.Begin) {
			field = fields.begin.push(item)
			fields.separate.push(-1)
			fields.end.push(-1)
			fields.parent.push(stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1)
			fields.simple.push(0)
			fields.instruction.push(-1)
			fields.lastInstruction.push(-1)
			stack.push(field)
		} else if (type === FieldCharType.Separate) {
			const top = stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1

			if (top >= 0 && fields.separate.get(top) < 0 && fields.simple.get(top) === 0) {
				fields.separate.set(top, item)
				field = top
			}
		} else if (type === FieldCharType.End) {
			const top = stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1

			if (top >= 0 && fields.simple.get(top) === 0) {
				stack.pop()
				fields.end.set(top, item)
				field = top
			} else {
				this.shared.counts.unbalancedFieldEnds++
			}
		}

		this.setAux(item, type | flags | ((field + 1) << 4))
	}

	private simpleField(node: number, parent: number, depth: number): void {
		const fields = this.field
		const stack = this.fieldStack
		const item = this.open(Item.FieldSimple, node, parent, 0)
		const field = fields.begin.push(item)

		fields.separate.push(-1)
		fields.end.push(-1)
		fields.parent.push(stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1)
		fields.simple.push(1)
		fields.instruction.push(-1)
		fields.lastInstruction.push(-1)
		this.setAux(item, field)

		const height = stack.length

		stack.push(field)
		this.children(node, item, depth + 1, Ctx.Inline, false)

		// Complex fields left open inside a simple field end with it.
		this.shared.counts.unterminatedFields += stack.length - height - 1
		stack.length = height
		this.close(item)
	}

	private marker(node: number, parent: number, code: El): void {
		const reader = this.reader

		switch (code) {
			case El.BookmarkStart:
			case El.BookmarkEnd: {
				const start = code === El.BookmarkStart
				const item = this.leaf(start ? Item.BookmarkStart : Item.BookmarkEnd, node, parent, -1)
				const id = reader.attr(node, Ns.W, "id")

				if (id === undefined) return

				const bookmarks = this.bookmark
				let row = bookmarks.ids.get(id)

				if (row === undefined) {
					row = bookmarks.start.push(-1)
					bookmarks.end.push(-1)
					bookmarks.ids.set(id, row)
				}

				// Repeated starts or ends keep the first, as Word does.
				if (start && bookmarks.start.get(row) < 0) bookmarks.start.set(row, item)
				if (!start && bookmarks.end.get(row) < 0) bookmarks.end.set(row, item)

				this.setAux(item, row)
				this.shared.maxIds.bookmark = Math.max(this.shared.maxIds.bookmark, reader.int(node, Ns.W, "id", -1))

				return
			}
			case El.CommentRangeStart:
			case El.CommentRangeEnd: {
				const start = code === El.CommentRangeStart
				const item = this.leaf(start ? Item.CommentRangeStart : Item.CommentRangeEnd, node, parent, -1)
				const id = reader.attr(node, Ns.W, "id")

				this.shared.maxIds.comment = Math.max(this.shared.maxIds.comment, reader.int(node, Ns.W, "id", -1))

				if (id === undefined) return

				const anchors = this.shared.anchors
				const row = anchors.row(id)

				if (start && anchors.startItem.get(row) < 0) {
					anchors.startPart.set(row, this.partIndex)
					anchors.startItem.set(row, item)
				} else if (!start && anchors.endItem.get(row) < 0) {
					anchors.endPart.set(row, this.partIndex)
					anchors.endItem.set(row, item)
				}

				this.setAux(item, row)

				return
			}
			case El.MoveFromRangeStart:
			case El.MoveToRangeStart: {
				const from = code === El.MoveFromRangeStart
				const item = this.leaf(from ? Item.MoveFromRangeStart : Item.MoveToRangeStart, node, parent, -1)

				this.setAux(item, this.addRevision(from ? Revision.MoveFromRange : Revision.MoveToRange, item, node))

				return
			}
			case El.MoveFromRangeEnd:
				this.leaf(Item.MoveFromRangeEnd, node, parent, reader.int(node, Ns.W, "id", -1))

				return
			case El.MoveToRangeEnd:
				this.leaf(Item.MoveToRangeEnd, node, parent, reader.int(node, Ns.W, "id", -1))

				return
			case El.PermStart:
			case El.PermEnd: {
				const id = reader.int(node, Ns.W, "id", -1)

				this.shared.maxIds.permission = Math.max(this.shared.maxIds.permission, id)
				this.leaf(code === El.PermStart ? Item.PermissionStart : Item.PermissionEnd, node, parent, id)

				return
			}
			default:
				this.leaf(Item.CustomXmlRangeMarker, node, parent, 0)
		}
	}

	// A style reference's id; a malformed one counts as absent.
	private styleId(node: number): number {
		return this.reader.malformedNodes.has(node) ? -1 : this.shared.strings.intern(this.reader.attr(node, Ns.W, "val"))
	}

	// An equation is one item: the ids of the tracked changes inside it (w:ins / w:del around its runs, in its
	// objects' m:ctrlPr) count among the document's revision ids all the same, so new ones never repeat them.
	private mathRevisionIds(node: number): void {
		const reader = this.reader
		const document = reader.document
		// Iterative: an equation may nest deeper than the stack goes.
		const stack = [node]

		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			for (let child = document.firstChildElement(next); child >= 0; child = document.nextSiblingElement(child)) {
				if (reader.group(child) === Ns.W && MATH_CHANGES.has(document.localName(child)))
					this.shared.maxIds.revision = Math.max(this.shared.maxIds.revision, reader.int(child, Ns.W, "id", -1))

				stack.push(child)
			}
		}
	}

	private addRevision(kind: Revision, item: number, node: number): number {
		const reader = this.reader
		const revisions = this.revision
		const id = reader.int(node, Ns.W, "id", -1)
		const strings = this.shared.strings

		this.shared.maxIds.revision = Math.max(this.shared.maxIds.revision, id)
		revisions.kind.push(kind)
		revisions.item.push(item)
		revisions.node.push(node)
		revisions.id.push(id)
		revisions.author.push(strings.intern(reader.attr(node, Ns.W, "author")))

		return revisions.date.push(strings.intern(reader.attr(node, Ns.W, "date")))
	}

	private revisionWrapper(kind: Item, revision: Revision, node: number, parent: number, depth: number, ctx: Ctx, top: boolean): void {
		const item = this.open(kind, node, parent, 0)

		this.setAux(item, this.addRevision(revision, item, node))
		this.children(node, item, depth + 1, ctx, top)
		this.close(item)
	}

	// A transparent wrapper whose first `props` child (smartTagPr, customXmlPr) is its own property element.
	private wrapper(kind: Item, node: number, parent: number, depth: number, ctx: Ctx, top: boolean, props: El): void {
		const document = this.document
		const item = this.open(kind, node, parent, -1)
		let seenProps = false

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (!seenProps && props !== El.Unknown && this.reader.code(child) === props) {
				seenProps = true
				this.setAux(item, child)

				continue
			}

			this.content(child, item, depth + 1, ctx, top)
		}

		this.close(item)
	}

	private bidi(node: number, parent: number, depth: number): void {
		const item = this.open(Item.Bidi, node, parent, this.reader.equals(node, Ns.W, "val", "rtl") ? 1 : 0)

		this.children(node, item, depth + 1, Ctx.Inline, false)
		this.close(item)
	}

	private alternateContent(node: number, parent: number, depth: number, ctx: Ctx, top: boolean): void {
		const reader = this.reader
		const document = this.document
		const selected = reader.selectBranch(node, understandsChoice)
		const alternates = this.alternate
		const item = this.open(Item.AlternateContent, node, parent, alternates.item.length)
		const firstBranch = this.branches.length

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (reader.group(child) === Ns.MC) this.branches.push(child)
		}

		alternates.item.push(item)
		alternates.selected.push(selected)
		alternates.fallback.push(reader.child(node, Ns.MC, "Fallback"))
		alternates.firstBranch.push(firstBranch)
		alternates.branchCount.push(this.branches.length - firstBranch)

		if (selected >= 0) this.children(selected, item, depth + 1, ctx, top)

		this.close(item)
	}

	private sdtElement(node: number, parent: number, depth: number, level: SdtLevel, top: boolean): void {
		const document = this.document
		const sdts = this.sdt
		const row = sdts.item.length
		const item = this.open(Item.Sdt, node, parent, row)
		const contentCtx: Ctx =
			level === SdtLevel.Block ? Ctx.Block : level === SdtLevel.Row ? Ctx.Rows : level === SdtLevel.Cell ? Ctx.Cells : Ctx.Inline
		let sdtPr = -1
		let sdtEndPr = -1
		let content = -1

		sdts.item.push(item)
		sdts.sdtPr.push(-1)
		sdts.sdtEndPr.push(-1)
		sdts.content.push(-1)
		sdts.level.push(level)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const code = this.reader.code(child)

			if (code === El.SdtPr && sdtPr < 0) {
				sdtPr = child
			} else if (code === El.SdtEndPr && sdtEndPr < 0) {
				sdtEndPr = child
			} else if (code === El.SdtContent && content < 0) {
				content = child
				this.children(child, item, depth + 1, contentCtx, top)
			} else {
				this.content(child, item, depth + 1, contentCtx, top)
			}
		}

		sdts.sdtPr.set(row, sdtPr)
		sdts.sdtEndPr.set(row, sdtEndPr)
		sdts.content.set(row, content)
		this.close(item)
	}

	private paragraphElement(node: number, parent: number, depth: number, top: boolean): void {
		const document = this.document
		const reader = this.reader
		const table = this.paragraph
		const row = table.item.length
		const item = this.open(Item.Paragraph, node, parent, row)

		// Rows are reserved up front: text boxes inside the paragraph add paragraphs of their own.
		table.item.push(item)
		table.pPr.push(-1)
		table.style.push(-1)
		table.numPr.push(-1)
		table.sectPr.push(-1)
		table.markRPr.push(-1)
		table.pPrChange.push(-1)
		table.markRevision.push(0)
		table.markRevisionRow.push(-1)
		let pPr = -1
		let style = -1
		let numPr = -1
		let sectPr = -1
		let markRPr = -1
		let change = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (pPr < 0 && reader.code(child) === El.PPr) {
				pPr = child

				for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
					switch (reader.code(property)) {
						case El.PStyle:
							style = this.styleId(property)

							break
						case El.NumPr:
							numPr = property
							this.childRevision(property, El.NumberingChange, Revision.Numbering, item)

							break
						case El.SectPr:
							sectPr = property
							this.childRevision(property, El.SectPrChange, Revision.SectionProperties, item)

							break
						case El.RPr:
							markRPr = property
							this.markRevisions(property, item, row)

							break
						case El.PPrChange:
							change = property
							this.addRevision(Revision.ParagraphProperties, item, property)

							break
					}
				}

				continue
			}

			this.content(child, item, depth + 1, Ctx.Inline, false)
		}

		table.pPr.set(row, pPr)
		table.style.set(row, style)
		table.numPr.set(row, numPr)
		table.sectPr.set(row, sectPr)
		table.markRPr.set(row, markRPr)
		table.pPrChange.set(row, change)
		this.close(item)

		if (sectPr >= 0) {
			if (top && this.storyKind === "body") {
				this.shared.sections.push({ part: this.partIndex, item, node: sectPr })
			} else {
				this.shared.counts.ignoredSectionProperties++
			}
		}
	}

	private flagRevision(
		table: { readonly revision: Column; readonly revisionRow: Column },
		row: number,
		flag: number,
		revision: number
	): void {
		table.revision.set(row, table.revision.get(row) | flag)

		if (table.revisionRow.get(row) < 0) table.revisionRow.set(row, revision)
	}

	private childRevision(node: number, code: El, kind: Revision, item: number): void {
		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.reader.code(child) === code) this.addRevision(kind, item, child)
		}
	}

	private markRevisions(rPr: number, item: number, row: number): void {
		const document = this.document
		const table = this.paragraph

		for (let child = document.firstChildElement(rPr); child >= 0; child = document.nextSiblingElement(child)) {
			const code = this.reader.code(child)

			if (code === El.RPrChange) {
				this.addRevision(Revision.RunProperties, item, child)

				continue
			}

			const mark = MARK_REVISIONS[code]

			if (mark === undefined) continue

			const revision = this.addRevision(mark[0], item, child)

			table.markRevision.set(row, table.markRevision.get(row) | mark[1])

			if (table.markRevisionRow.get(row) < 0) table.markRevisionRow.set(row, revision)
		}
	}

	private runElement(node: number, parent: number, depth: number): void {
		const document = this.document
		const reader = this.reader
		const table = this.run
		const row = table.item.length
		const item = this.open(Item.Run, node, parent, row)

		table.item.push(item)
		table.rPr.push(-1)
		table.style.push(-1)
		table.rPrChange.push(-1)
		let rPr = -1
		let style = -1
		let change = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const code = reader.code(child)

			if (code === El.RPr && rPr < 0) {
				rPr = child

				for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
					const propertyCode = reader.code(property)

					if (propertyCode === El.RStyle) {
						style = this.styleId(property)
					} else if (propertyCode === El.RPrChange) {
						change = property
						this.addRevision(Revision.RunProperties, item, property)
					}
				}

				continue
			}

			if (!this.reader.wellFormed(child)) {
				this.leaf(Item.Opaque, child, item, 0)
			} else if (!this.runContent(child, item, depth + 1, code)) {
				if (code === El.AlternateContent) {
					this.alternateContent(child, item, depth + 1, Ctx.Run, false)
				} else {
					this.leaf(Item.Opaque, child, item, 0)
				}
			}
		}

		table.rPr.set(row, rPr)
		table.style.set(row, style)
		table.rPrChange.set(row, change)
		this.close(item)
	}

	private tableElement(node: number, parent: number, depth: number): void {
		drain(this.tableSteps(node, parent, depth))
	}

	// tableElement yielding after each row.
	private *tableSteps(node: number, parent: number, depth: number): Generator<void, void> {
		const document = this.document
		const reader = this.reader
		const table = this.table
		const item = this.open(Item.Table, node, parent, table.item.length)
		const row = table.item.push(item)
		let tblPr = -1
		let tblGrid = -1
		let style = -1

		table.tblPr.push(-1)
		table.tblGrid.push(-1)
		table.style.push(-1)
		table.depth.push(this.tableDepth)
		this.tableDepth++

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const code = reader.code(child)

			if (code === El.TblPr && tblPr < 0) {
				tblPr = child

				for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
					const propertyCode = reader.code(property)

					if (propertyCode === El.TblStyle) style = this.styleId(property)
					else if (propertyCode === El.TblPrChange) this.addRevision(Revision.TableProperties, item, property)
				}
			} else if (code === El.TblGrid && tblGrid < 0) {
				tblGrid = child
				this.childRevision(child, El.TblGridChange, Revision.TableGrid, item)
			} else {
				this.content(child, item, depth + 1, Ctx.Rows, false)

				yield
			}
		}

		this.tableDepth--
		table.tblPr.set(row, tblPr)
		table.tblGrid.set(row, tblGrid)
		table.style.set(row, style)
		this.close(item)
	}

	private rowElement(node: number, parent: number, depth: number): void {
		const document = this.document
		const reader = this.reader
		const rows = this.row
		const row = rows.item.length
		const item = this.open(Item.Row, node, parent, row)

		rows.item.push(item)
		rows.trPr.push(-1)
		rows.tblPrEx.push(-1)
		rows.revision.push(0)
		rows.revisionRow.push(-1)
		let trPr = -1
		let tblPrEx = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const code = reader.code(child)

			if (code === El.TrPr && trPr < 0) {
				trPr = child

				for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
					switch (reader.code(property)) {
						case El.Ins:
							this.flagRevision(rows, row, RevisionFlag.Inserted, this.addRevision(Revision.RowInsertion, item, property))

							break
						case El.Del:
							this.flagRevision(rows, row, RevisionFlag.Deleted, this.addRevision(Revision.RowDeletion, item, property))

							break
						case El.TrPrChange:
							this.addRevision(Revision.RowProperties, item, property)

							break
					}
				}
			} else if (code === El.TblPrEx && tblPrEx < 0) {
				tblPrEx = child
				this.childRevision(child, El.TblPrExChange, Revision.TablePropertiesException, item)
			} else {
				this.content(child, item, depth + 1, Ctx.Cells, false)
			}
		}

		rows.trPr.set(row, trPr)
		rows.tblPrEx.set(row, tblPrEx)
		this.close(item)
	}

	private cellElement(node: number, parent: number, depth: number): void {
		const document = this.document
		const reader = this.reader
		const cells = this.cell
		const row = cells.item.length
		const item = this.open(Item.Cell, node, parent, row)

		cells.item.push(item)
		cells.tcPr.push(-1)
		cells.revision.push(0)
		cells.revisionRow.push(-1)
		let tcPr = -1

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (tcPr < 0 && reader.code(child) === El.TcPr) {
				tcPr = child

				for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
					switch (reader.code(property)) {
						case El.CellIns:
							this.flagRevision(cells, row, RevisionFlag.Inserted, this.addRevision(Revision.CellInsertion, item, property))

							break
						case El.CellDel:
							this.flagRevision(cells, row, RevisionFlag.Deleted, this.addRevision(Revision.CellDeletion, item, property))

							break
						case El.CellMerge:
							this.flagRevision(cells, row, RevisionFlag.Merged, this.addRevision(Revision.CellMerge, item, property))

							break
						case El.TcPrChange:
							this.addRevision(Revision.CellProperties, item, property)

							break
					}
				}

				continue
			}

			this.content(child, item, depth + 1, Ctx.Block, false)
		}

		cells.tcPr.set(row, tcPr)
		this.close(item)
	}

	private ruby(node: number, parent: number, depth: number): void {
		const document = this.document
		const item = this.open(Item.Ruby, node, parent, -1)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			switch (this.reader.code(child)) {
				case El.RubyPr:
					this.setAux(item, child)

					break
				case El.Rt:
					this.rubyPart(Item.RubyText, child, item, depth + 1)

					break
				case El.RubyBase:
					this.rubyPart(Item.RubyBase, child, item, depth + 1)

					break
				default:
					this.leaf(Item.Opaque, child, item, 0)
			}
		}

		this.close(item)
	}

	private rubyPart(kind: Item, node: number, parent: number, depth: number): void {
		const item = this.open(kind, node, parent, 0)

		this.children(node, item, depth + 1, Ctx.Inline, false)
		this.close(item)
	}

	private drawing(node: number, parent: number, depth: number): void {
		const drawings = this.shared.drawings
		const index = drawings.length
		const item = this.open(Item.Drawing, node, parent, index)

		drawings.push(PLACEHOLDER_DRAWING)

		const textboxes = this.nestedStories(node, item, depth + 1, false)
		const info = readDrawing(this.reader, node, index, this.partIndex, item, textboxes)

		drawings[index] = info
		this.shared.maxIds.docPr = Math.max(this.shared.maxIds.docPr, info.docPrId)
		this.close(item)
	}

	private vml(node: number, parent: number, depth: number, kind: VmlKind): void {
		const vml = this.shared.vml
		const index = vml.length
		const item = this.open(kind === "picture" ? Item.VmlPicture : Item.EmbeddedObject, node, parent, index)

		vml.push(PLACEHOLDER_VML)

		// An OLE object's DrawingML preview is a drawing item of its own.
		const textboxes = this.nestedStories(node, item, depth + 1, kind === "object")

		vml[index] = readVml(this.reader, node, kind, index, this.partIndex, item, textboxes)
		this.close(item)
	}

	// Text box stories (w:txbxContent) anywhere below a drawing or VML element, outside the branches of
	// mc:AlternateContent that are not selected, in document order; with `drawings`, w:drawing elements
	// become child drawing items too. Returns how many text boxes it found directly.
	private nestedStories(root: number, parent: number, depth: number, drawings: boolean): number {
		const document = this.document
		const reader = this.reader
		const end = document.end(root)
		let found = 0
		let node = root + 1

		while (node < document.count && document.start(node) < end) {
			if (document.kinds[node] !== NodeKind.Element) {
				node++

				continue
			}

			const code = reader.code(node)

			if (code === El.TxbxContent) {
				if (depth > MAX_DEPTH) {
					this.shared.counts.depthLimited++
				} else {
					this.storyContainer(node, parent, Item.Textbox, "textbox", undefined, depth + 1)
					found++
				}

				node = afterSubtree(this.document, node, root)
			} else if (code === El.AlternateContent) {
				if (depth > MAX_DEPTH) {
					this.shared.counts.depthLimited++
				} else {
					const selected = reader.selectBranch(node, understandsChoice)

					if (selected >= 0) found += this.nestedStories(selected, parent, depth + 1, drawings)
				}

				node = afterSubtree(this.document, node, root)
			} else if (drawings && code === El.Drawing) {
				if (depth > MAX_DEPTH) this.shared.counts.depthLimited++
				else this.drawing(node, parent, depth + 1)

				node = afterSubtree(this.document, node, root)
			} else {
				node++
			}
		}

		return found
	}
}

function drain<T>(steps: Generator<void, T>): T {
	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

export function buildPart(
	reader: PartReader,
	shared: ModelTables,
	partIndex: number,
	name: string,
	relationships: Relationships
): StoryPart {
	return drain(new PartBuilder(reader, shared, partIndex).steps(name, relationships))
}

// buildPart in slices: the host is given a turn between top-level blocks whenever the slice is used up.
// Nothing else may build into `shared` meanwhile.
export async function buildPartSliced(
	reader: PartReader,
	shared: ModelTables,
	partIndex: number,
	name: string,
	relationships: Relationships,
	slicing: Slicing
): Promise<StoryPart> {
	const clock = sliceClock(slicing)
	const steps = new PartBuilder(reader, shared, partIndex).steps(name, relationships)

	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
		if (clock.due) await clock.pause()
	}
}
