import { OdfNs } from "../../odf/namespaces"
import type { XlsxSheetView } from "../../xlsx/model/types"
import { escapeAttribute, Namespaces, parseXml, XmlEditor, type XmlDocument } from "../../xml/index"

// settings.xml written again where the view an edit changed is held (ODF 1.3 Part 3 §3.10, LibreOffice's
// "ooo:view-settings"): the active sheet, and per sheet its frozen panes, scroll position, active cell, zoom and grid,
// as settings.ts reads them. Every other byte stays as it was.

export interface SheetViewState {
	readonly name: string
	// The name the source's settings know the sheet by (renamed since), undefined for a new sheet.
	readonly sourceName: string | undefined
	readonly view: XlsxSheetView
	readonly changed: boolean
}

interface Item {
	readonly name: string
	readonly type: string
	readonly value: string
}

// The items a sheet's view comes to (settings.ts view() read backwards); with split, the source's split pane items
// stay as they are.
function viewItems(view: XlsxSheetView, split = false): Item[] {
	const items: Item[] = [
		{ name: "CursorPositionX", type: "int", value: String(view.activeCol) },
		{ name: "CursorPositionY", type: "int", value: String(view.activeRow) },
		{ name: "PositionLeft", type: "int", value: String(view.leftCol) },
		{ name: "PositionTop", type: "int", value: String(view.topRow) },
		{ name: "ZoomValue", type: "int", value: String(view.zoom) },
		{ name: "ShowGrid", type: "boolean", value: view.gridLines ? "true" : "false" }
	]

	if (split) return items

	const frozen = view.frozen
	const cols = frozen?.cols ?? 0
	const rows = frozen?.rows ?? 0

	items.push(
		{ name: "HorizontalSplitMode", type: "short", value: cols > 0 ? "2" : "0" },
		{ name: "VerticalSplitMode", type: "short", value: rows > 0 ? "2" : "0" },
		{ name: "HorizontalSplitPosition", type: "int", value: String(cols > 0 ? view.leftCol + cols : 0) },
		{ name: "VerticalSplitPosition", type: "int", value: String(rows > 0 ? view.topRow + rows : 0) },
		// The pane the cursor is in: 3 bottom right, 2 bottom left, 1 top right (LibreOffice's ScSplitPos).
		{ name: "ActiveSplitRange", type: "short", value: rows > 0 ? (cols > 0 ? "3" : "2") : cols > 0 ? "1" : "2" },
		{ name: "PositionRight", type: "int", value: String(cols > 0 ? (frozen?.topLeftCol ?? view.leftCol + cols) : 0) },
		{ name: "PositionBottom", type: "int", value: String(rows > 0 ? (frozen?.topLeftRow ?? view.topRow + rows) : 0) }
	)

	return items
}

function itemMarkup(prefix: string, item: Item): string {
	return `<${prefix}config-item ${prefix}name="${escapeAttribute(item.name)}" ${prefix}type="${item.type}">${escapeAttribute(item.value)}</${prefix}config-item>`
}

function elements(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) out.push(child)

	return out
}

// settings.xml with the views given; null when nothing in it changes.
export function writeSettings(
	bytes: Uint8Array,
	activeSheet: string,
	activeChanged: boolean,
	sheets: readonly SheetViewState[]
): Uint8Array | null {
	const document = parseXml(bytes)
	const namespaces = new Namespaces(document, { lenient: true })
	const editor = new XmlEditor(document)
	const config = (node: number, local: string): boolean =>
		namespaces.elementUri(node) === OdfNs.config && document.localName(node) === local
	const nameOf = (node: number): string | undefined => {
		for (const { name, value } of document.attributes(node)) if (name.endsWith(":name") || name === "name") return value

		return undefined
	}
	const root = document.documentElement()
	const prefix = ((): string => {
		for (const { name, value } of document.attributes(root))
			if (name.startsWith("xmlns:") && value === OdfNs.config) return `${name.slice(6)}:`

		return "config:"
	})()
	const settings = elements(document, root).find(
		node => namespaces.elementUri(node) === OdfNs.office && document.localName(node) === "settings"
	)
	const viewSet =
		settings === undefined
			? undefined
			: elements(document, settings).find(node => config(node, "config-item-set") && nameOf(node) === "ooo:view-settings")
	const views = viewSet === undefined ? undefined : elements(document, viewSet).find(node => nameOf(node) === "Views")
	const view = views === undefined ? undefined : elements(document, views).find(node => config(node, "config-item-map-entry"))

	if (view === undefined) return null

	const setItems = (entry: number, items: readonly Item[]): void => {
		const present = new Map<string, number>()

		for (const child of elements(document, entry)) {
			if (!config(child, "config-item")) continue

			const name = nameOf(child)

			if (name !== undefined) present.set(name, child)
		}

		const added: string[] = []

		for (const item of items) {
			const node = present.get(item.name)

			if (node === undefined) added.push(itemMarkup(prefix, item))
			else if (document.textContent(node) !== item.value) editor.setText(node, item.value)
		}

		if (added.length > 0) editor.append(entry, added.join(""))
	}

	// A split (mode 1 on either axis, LibreOffice's SC_SPLIT_NORMAL; Excel's pane state "split") reads as no frozen
	// pane: an unfrozen view keeps it as the source has it, a freeze replaces it as in Excel.
	const splitIn = (entry: number): boolean => {
		for (const child of elements(document, entry)) {
			if (!config(child, "config-item")) continue

			const name = nameOf(child)

			if ((name === "HorizontalSplitMode" || name === "VerticalSplitMode") && document.textContent(child).trim() === "1") return true
		}

		return false
	}

	if (activeChanged) setItems(view, [{ name: "ActiveTable", type: "string", value: activeSheet }])

	const tables = elements(document, view).find(node => config(node, "config-item-map-named") && nameOf(node) === "Tables")
	const entries = new Map<string, number>()

	for (const entry of tables === undefined ? [] : elements(document, tables)) {
		const name = nameOf(entry)

		if (name !== undefined) entries.set(name, entry)
	}

	const fresh: string[] = []

	for (const sheet of sheets) {
		const entry = sheet.sourceName === undefined ? undefined : entries.get(sheet.sourceName)

		if (entry !== undefined && sheet.name !== sheet.sourceName) editor.setAttribute(entry, `${prefix}name`, sheet.name)
		if (!sheet.changed) continue

		if (entry !== undefined) setItems(entry, viewItems(sheet.view, sheet.view.frozen === null && splitIn(entry)))
		else
			fresh.push(
				`<${prefix}config-item-map-entry ${prefix}name="${escapeAttribute(sheet.name)}">${viewItems(sheet.view)
					.map(item => itemMarkup(prefix, item))
					.join("")}</${prefix}config-item-map-entry>`
			)
	}

	if (fresh.length > 0) {
		if (tables !== undefined) editor.append(tables, fresh.join(""))
		else
			editor.append(view, `<${prefix}config-item-map-named ${prefix}name="Tables">${fresh.join("")}</${prefix}config-item-map-named>`)
	}

	return editor.changed ? editor.serialize() : null
}

// A view as settings.ts reads it, for telling whether an edit changed it.
export function sameView(a: XlsxSheetView, b: XlsxSheetView): boolean {
	const frozen = (view: XlsxSheetView): string =>
		view.frozen === null ? "" : `${view.frozen.rows},${view.frozen.cols},${view.frozen.topLeftRow},${view.frozen.topLeftCol}`

	return (
		frozen(a) === frozen(b) &&
		a.topRow === b.topRow &&
		a.leftCol === b.leftCol &&
		a.activeRow === b.activeRow &&
		a.activeCol === b.activeCol &&
		a.zoom === b.zoom &&
		a.gridLines === b.gridLines
	)
}
