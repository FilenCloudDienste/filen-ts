import { vi } from "vitest"
import { render } from "@testing-library/react"
import {
	DOCX_EDITOR_COMMANDS,
	NO_REVIEW,
	NO_VALUES,
	type DocxEditorSnapshot,
	type DocxFontChoice,
	type DocxTableContext
} from "@filen/office/core/docx/edit"
import { DocxEditToolbar, type DocxEditToolbarProps } from "@/features/preview/components/docxEditToolbar"
import { themeSwatches } from "@/features/preview/components/docxEditor.logic"
import "@/lib/i18n"

// The Word editor's ribbon on its own, as its tests render it: a snapshot with every command enabled, the
// document's fonts and theme, and spies for what it runs.

export const FONTS: readonly DocxFontChoice[] = [
	{ family: "+headings", name: "Calibri Light", kind: "theme", role: "headings" },
	{ family: "+body", name: "Calibri", kind: "theme", role: "body" },
	{ family: "Georgia", name: "Georgia", kind: "document" },
	{ family: "Arial", name: "Arial", kind: "common" }
]

const THEME: Record<string, string> = {
	background1: "FFFFFF",
	text1: "000000",
	background2: "E7E6E6",
	text2: "44546A",
	accent1: "4472C4",
	accent2: "ED7D31",
	accent3: "A5A5A5",
	accent4: "FFC000",
	accent5: "5B9BD5",
	accent6: "70AD47"
}

export const TABLE: DocxTableContext = {
	rows: 2,
	columns: 3,
	fromRow: 0,
	toRow: 1,
	fromColumn: 1,
	toColumn: 2,
	mergeable: false,
	splittable: true,
	headerRow: true,
	styleId: "TableGrid",
	depth: 0,
	widths: [2000, 2000, 2000],
	rtl: false,
	align: "center",
	vAlign: null,
	shading: "FF0000",
	styles: [
		{ id: "TableGrid", name: "Table Grid" },
		{ id: "GridTable4", name: "Grid Table 4" }
	]
}

export const PICTURE = {
	kind: "picture",
	anchored: false,
	wrap: "inline",
	pos: 5,
	rotation: 0,
	resizable: true,
	rotatable: true,
	placeable: true,
	croppable: true
} as unknown as NonNullable<DocxEditorSnapshot["context"]["drawing"]>

export function ribbonSnapshot(overrides: Partial<DocxEditorSnapshot> = {}): DocxEditorSnapshot {
	const enabled = Object.fromEntries(DOCX_EDITOR_COMMANDS.map(command => [command.type, true])) as DocxEditorSnapshot["enabled"]

	return {
		version: 1,
		readOnly: false,
		readOnlyReasons: [],
		dirty: false,
		canUndo: false,
		canRedo: false,
		selection: { empty: true, from: 1, to: 1, locked: null, paragraphs: 1 },
		formats: { bold: "off", italic: "off", underline: "off", strike: "off" },
		paragraph: { style: "normal", styleName: null, align: "start", list: "none", level: null },
		values: { ...NO_VALUES, font: "Georgia", size: 22, color: "auto", colorRgb: "auto" },
		context: {
			story: { kind: "body", index: 0 },
			table: null,
			drawing: null,
			control: null,
			field: null,
			link: null,
			comment: null,
			equation: null
		},
		review: NO_REVIEW,
		enabled,
		...overrides
	}
}

// The snapshot with the selection in `context` (a table, a picture).
export function ribbonSnapshotIn(context: Partial<DocxEditorSnapshot["context"]>): DocxEditorSnapshot {
	const plain = ribbonSnapshot()

	return { ...plain, context: { ...plain.context, ...context } }
}

export function renderRibbon(props: Partial<DocxEditToolbarProps> = {}) {
	const execute = vi.fn()
	const onPainterCancel = vi.fn()
	const requestInput = vi.fn()
	const onFindOpen = vi.fn()
	const onZoom = vi.fn()
	const onReflowChange = vi.fn()
	const clipboard = { cut: vi.fn(), copy: vi.fn(), paste: vi.fn() }

	const result = render(
		<DocxEditToolbar
			snapshot={ribbonSnapshot()}
			readOnly={false}
			apple={false}
			execute={execute}
			clipboard={clipboard}
			viewOnly={[]}
			find={{
				open: false,
				replace: false,
				focus: 0,
				controls: {
					query: "",
					caseSensitive: false,
					count: 0,
					capped: false,
					active: -1,
					search: vi.fn(),
					step: vi.fn(),
					close: vi.fn(),
					replace: { disabled: true, one: vi.fn(), all: vi.fn() }
				}
			}}
			onFindOpen={onFindOpen}
			onFindClosed={vi.fn()}
			markup={null}
			onMarkupChange={vi.fn()}
			zoom={1}
			onZoom={onZoom}
			reflow={false}
			onReflowChange={onReflowChange}
			surface="pages"
			styles={["normal", "heading1", "heading2"]}
			fonts={FONTS}
			theme={themeSwatches(name => THEME[name])}
			painter="off"
			onPainterCancel={onPainterCancel}
			fieldCodes={false}
			inputRequest={null}
			requestInput={requestInput}
			onInputDone={vi.fn()}
			{...props}
		/>
	)

	return { ...result, execute, onPainterCancel, requestInput, onFindOpen, onZoom, onReflowChange, clipboard }
}
