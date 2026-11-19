import { closeHistory } from "prosemirror-history"
import { Mark, type Node } from "prosemirror-model"
import type { EditorState, Transaction } from "prosemirror-state"
import type { StoryDoc } from "../build"
import type { DocxCommandOf, DocxEditorCommandType } from "../commands"
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "../commands/tables"
import type { FeatureHandlers, StoryCommandContext, StoryCommandHandler } from "../registry"
import { NO_SOURCE, docxSchema } from "../schema"
import type { DocxEditorSession } from "../session"
import {
	alignCells,
	alignTable,
	canInsertTable,
	canMerge,
	canSplit,
	deleteColumns,
	deleteRows,
	deleteTable,
	distributeColumns,
	insertColumns,
	insertRows,
	insertTable,
	mergeCells,
	removeNewTables,
	setColumnWidth,
	setTableStyle,
	shadeCells,
	splitCell,
	tableAt,
	toggleHeaderRows,
	type TableAt
} from "../tables/ops"
import type { RevertibleUnits } from "../unsavable"

// Table structure and properties: the commands act on the table holding the selection (its innermost one)
// and on the cells the selection touches.

const nodes = docxSchema.nodes

function at(context: StoryCommandContext): TableAt | null {
	return tableAt(context.state, context.session.story.part, context.context.store)
}

// A handler for a command acting on the table at the selection.
function onTable<T extends DocxEditorCommandType>(
	run: (context: StoryCommandContext, table: TableAt, command: DocxCommandOf<T>) => Transaction | null,
	enabled: (table: TableAt, state: EditorState) => boolean = () => true
): StoryCommandHandler<T> {
	return {
		enabled: context => {
			const table = at(context)

			return table !== null && enabled(table, context.state)
		},
		run: (context, command) => {
			const table = at(context)

			return table === null ? null : run(context, table, command)
		}
	}
}

const rowsFit = (table: TableAt): boolean => table.map.height + table.cells.bottom - table.cells.top <= MAX_TABLE_ROWS
const columnsFit = (table: TableAt): boolean => table.map.grid.length + table.cells.right - table.cells.left <= MAX_TABLE_COLUMNS

// ---- revertible units: tables ---------------------------------------------------------------------------

// A failed save takes back a table as a whole where the blocks the session reports cannot: a table the editor
// made (it goes), and a source table whose rows or cells changed and that holds an edited paragraph (it goes
// back to its last-saved form with everything in it; one without an edited paragraph is a block the session
// reports itself). Keys: a source table's item; -1 - k for the k-th new table found by edited().
const newTables = new WeakMap<StoryDoc, readonly Node[]>()
const sourceTables = new WeakMap<StoryDoc, Map<number, Node>>()

// The tables of the story as it was built, by item.
function builtTables(story: StoryDoc): Map<number, Node> {
	let tables = sourceTables.get(story)

	if (tables === undefined) {
		const found = new Map<number, Node>()

		story.doc.descendants(node => {
			if (node.isInline || node.isTextblock || node.type === nodes.locked_block) return false
			if (node.type === nodes.table && !found.has(node.attrs["src"] as number)) found.set(node.attrs["src"] as number, node)

			return true
		})
		tables = found
		sourceTables.set(story, tables)
	}

	return tables
}

function sameAttrs(a: Node, b: Node): boolean {
	return (a.attrs === b.attrs || Object.keys(a.attrs).every(key => a.attrs[key] === b.attrs[key])) && Mark.sameSet(a.marks, b.marks)
}

// Whether a table's rows and cells (their sources, spans, merges and properties) are as built, whatever their
// content.
function sameStructure(a: Node, b: Node): boolean {
	if (a === b) return true
	if (!sameAttrs(a, b) || a.childCount !== b.childCount) return false

	for (let r = 0; r < a.childCount; r++) {
		const x = a.child(r)
		const y = b.child(r)

		if (x === y) continue
		if (!sameAttrs(x, y) || x.childCount !== y.childCount) return false

		for (let c = 0; c < x.childCount; c++) if (!sameAttrs(x.child(c), y.child(c))) return false
	}

	return true
}

function tableUnits(session: DocxEditorSession): number[] {
	const doc = session.state.doc
	const made: Node[] = []
	const keys = new Set<number>()

	doc.descendants(node => {
		if (node.isInline || node.isTextblock || node.type === nodes.locked_block) return false
		if (node.type !== nodes.table) return true
		if ((node.attrs["src"] as number) !== NO_SOURCE) return true

		// The outermost new table: what is inside it goes with it.
		made.push(node)
		keys.add(-1 - (made.length - 1))

		return false
	})

	const built = builtTables(session.story)

	for (const pos of session.editedBlocks()) {
		const $pos = doc.resolve(pos)

		for (let d = $pos.depth; d >= 1; d--) {
			const node = $pos.node(d)
			const src = node.attrs["src"] as number
			const original = built.get(src)

			if (node.type === nodes.table && src !== NO_SOURCE && original !== undefined && !sameStructure(original, node)) keys.add(src)
		}
	}

	newTables.set(session.story, made)

	return [...keys]
}

// Positions of the units `keys` in `doc`: source tables by item, new tables by identity.
function unitPositions(story: StoryDoc, doc: Node, keys: readonly number[]): { sources: number[]; made: number[] } {
	const sources = new Set(keys.filter(key => key >= 0))
	const made = new Set(keys.filter(key => key < 0).map(key => newTables.get(story)?.[-1 - key]))
	const out = { sources: [] as number[], made: [] as number[] }

	doc.descendants((node, pos) => {
		if (node.isInline || node.isTextblock || node.type === nodes.locked_block) return false
		if (node.type !== nodes.table) return true

		if (made.has(node)) out.made.push(pos)
		else if (sources.has(node.attrs["src"] as number)) out.sources.push(pos)

		return true
	})

	return out
}

export const TABLE_UNITS: RevertibleUnits = {
	kind: "table",
	edited: tableUnits,
	withReverted(session, keys) {
		const { sources } = unitPositions(session.story, session.state.doc, keys)
		let out = sources.length === 0 ? session : session.withReverted(sources)
		const { made } = unitPositions(session.story, out.state.doc, keys)
		const tr = made.length === 0 ? null : removeNewTables(out.state, made)

		if (tr !== null) out = out.withTransaction(tr)

		return out
	},
	revert(session, keys) {
		const doc = session.state.doc
		const { sources, made } = unitPositions(session.story, doc, keys)
		const tr = made.length === 0 ? null : removeNewTables(session.state, made)
		let count = 0

		if (tr !== null && session.dispatch(tr)) count += made.length

		if (sources.length > 0) {
			const after = unitPositions(session.story, session.state.doc, keys).sources

			count += session.revert(after.map(pos => session.state.doc.nodeAt(pos)).filter(node => node !== null))
		}

		return count
	}
}

export const TABLE_HANDLERS: FeatureHandlers = {
	story: {
		"table.insert": {
			// A selection not starting in a paragraph (all, a node, cells) is deleted first and the caret it leaves
			// tested then (run).
			enabled: context => {
				const selection = context.state.selection

				return canInsertTable(context.state) || (!selection.empty && selection.$from.parent.type !== nodes.paragraph)
			},
			run: (context, command) => {
				const part = context.session.story.part

				if (context.state.selection.empty) return insertTable(context.state, context.context, part, command.rows, command.cols)

				// The table replaces the selection (Word): the deletion is the user's own edit (tracked while tracking
				// is on), the table joins its undo step.
				const deletion = closeHistory(context.state.tr.deleteSelection())

				if (!canInsertTable(context.state.apply(deletion)) || !context.session.dispatch(deletion)) return null

				return insertTable(context.session.state, context.context, part, command.rows, command.cols, deletion)
			}
		},
		"table.delete": onTable((context, table) => deleteTable(context.state, context.context, table)),
		"table.row.insertAbove": onTable(
			(context, table) => insertRows(context.state, context.context, context.session.story.part, table, false),
			rowsFit
		),
		"table.row.insertBelow": onTable(
			(context, table) => insertRows(context.state, context.context, context.session.story.part, table, true),
			rowsFit
		),
		"table.row.delete": onTable((context, table) => deleteRows(context.state, context.context, table)),
		"table.column.insertLeft": onTable(
			(context, table) => insertColumns(context.state, context.context, context.session.story.part, table, false),
			columnsFit
		),
		"table.column.insertRight": onTable(
			(context, table) => insertColumns(context.state, context.context, context.session.story.part, table, true),
			columnsFit
		),
		"table.column.delete": onTable((context, table) => deleteColumns(context.state, context.context, table)),
		"table.cells.merge": onTable((context, table) => mergeCells(context.state, table), canMerge),
		"table.cell.split": onTable(
			(context, table, command) => splitCell(context.state, context.session.story.part, table, command.rows, command.cols),
			canSplit
		),
		"table.row.header": onTable((context, table) =>
			toggleHeaderRows(context.state, context.context, context.session.story.part, table)
		),
		"table.style": onTable((context, table, command) =>
			setTableStyle(context.state, context.context, context.session.story.part, table, command.styleId)
		),
		"table.align": onTable((context, table, command) =>
			alignTable(context.state, context.context, context.session.story.part, table, command.align)
		),
		"table.column.width": onTable((context, table, command) =>
			setColumnWidth(context.state, context.context, context.session.story.part, table, command.index, command.twips)
		),
		"table.cell.shading": onTable((context, table, command) =>
			shadeCells(context.state, context.context, context.session.story.part, table, command)
		),
		"table.cell.vAlign": onTable((context, table, command) =>
			alignCells(context.state, context.context, context.session.story.part, table, command.align)
		),
		"table.distributeColumns": onTable((context, table) =>
			distributeColumns(context.state, context.context, context.session.story.part, table)
		)
	},
	units: TABLE_UNITS
}
