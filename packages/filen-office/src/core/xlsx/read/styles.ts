import { MC_NAMESPACE, Namespaces, selectAlternateContent, type XmlDocument } from "../../xml/index"
import { StyleTable, type StyleSource } from "../model/styles"
import type { XlsxCellStyle } from "../model/types"
import { XlsxReadError } from "./errors"
import type { XlsxLimits } from "./limits"
import { childElements, intAttribute, intValue, parseBoolean, readBorder, readDxf, readFill, readFont, readXf } from "./styleRecords"

// styles.xml (ECMA-376 Part 1 §18.8.39 styleSheet), every record kind in file order; extLst is left to the
// part's bytes, which the writer keeps.
export function readStyles(document: XmlDocument | null, part: string, limits: XlsxLimits): StyleTable {
	const source: { -readonly [K in keyof StyleSource]: StyleSource[K] } = {
		numFmts: new Map(),
		fonts: [],
		fills: [],
		borders: [],
		cellStyleXfs: [],
		cellXfs: [],
		cellStyles: [],
		dxfs: [],
		indexedColors: null
	}

	if (document === null) return new StyleTable(source)

	const root = document.documentElement()
	const namespaces = new Namespaces(document, { lenient: true })
	const records = (node: number, local: string, read: (child: number) => void): void => {
		let count = 0

		for (const child of childElements(document, node)) {
			// A record wrapped in mc:AlternateContent is one record: the branch a reader that understands none of
			// its Choices takes (ECMA-376 Part 3 §10.2), so later indexes do not shift.
			const record = namespaces.is(child, MC_NAMESPACE, "AlternateContent")
				? alternateRecord(document, namespaces, child, local)
				: child

			if (record < 0 || document.localName(record) !== local) continue
			if (++count > limits.maxStyleRecords) throw new XlsxReadError("tooLarge", `Too many ${local} records`, part)

			read(record)
		}
	}

	for (const section of childElements(document, root)) {
		switch (document.localName(section)) {
			case "numFmts":
				records(section, "numFmt", node => {
					const id = intAttribute(document, node, "numFmtId", -1)
					const code = document.attribute(node, "formatCode")

					if (id >= 0 && code !== undefined && !source.numFmts.has(id)) source.numFmts.set(id, code)
				})
				break
			case "fonts":
				records(section, "font", node => source.fonts.push(readFont(document, node)))
				break
			case "fills":
				records(section, "fill", node => source.fills.push(readFill(document, node)))
				break
			case "borders":
				records(section, "border", node => source.borders.push(readBorder(document, node)))
				break
			case "cellStyleXfs":
				records(section, "xf", node => source.cellStyleXfs.push(readXf(document, node, true)))
				break
			case "cellXfs":
				records(section, "xf", node => source.cellXfs.push(readXf(document, node, false)))
				break
			case "cellStyles":
				records(section, "cellStyle", node => source.cellStyles.push(readCellStyle(document, node)))
				break
			case "dxfs":
				records(section, "dxf", node => source.dxfs.push(readDxf(document, node)))
				break
			case "colors":
				for (const colors of childElements(document, section)) {
					if (document.localName(colors) !== "indexedColors") continue

					const palette: number[] = []

					records(colors, "rgbColor", node => {
						const rgb = (document.attribute(node, "rgb") ?? "").trim()

						palette.push(
							/^[0-9A-Fa-f]{8}$/.test(rgb)
								? Number.parseInt(rgb, 16) >>> 0
								: /^[0-9A-Fa-f]{6}$/.test(rgb)
									? Number.parseInt(`FF${rgb}`, 16) >>> 0
									: 0
						)
					})
					source.indexedColors = palette
				}

				break
		}
	}

	return new StyleTable(source)
}

function alternateRecord(document: XmlDocument, namespaces: Namespaces, node: number, local: string): number {
	const branch = selectAlternateContent(namespaces, node, () => false)

	for (const child of branch < 0 ? [] : childElements(document, branch)) if (document.localName(child) === local) return child

	return -1
}

const CELL_STYLE_ATTRIBUTES = ["name", "xfId", "builtinId", "iLevel", "hidden", "customBuiltin"]

function readCellStyle(document: XmlDocument, node: number): XlsxCellStyle {
	const [name, xfId, builtinValue, levelValue, hiddenValue, customValue] = document.attributeValues(node, CELL_STYLE_ATTRIBUTES)
	const style: { -readonly [K in keyof XlsxCellStyle]: XlsxCellStyle[K] } = {
		name: name ?? "",
		xfId: intValue(xfId, 0)
	}
	const builtinId = intValue(builtinValue, -1)
	const outlineLevel = intValue(levelValue, -1)
	const hidden = parseBoolean(hiddenValue)
	const customBuiltin = parseBoolean(customValue)

	if (builtinId >= 0) style.builtinId = builtinId
	if (outlineLevel >= 0) style.outlineLevel = outlineLevel
	if (hidden !== undefined) style.hidden = hidden
	if (customBuiltin !== undefined) style.customBuiltin = customBuiltin

	return style
}
