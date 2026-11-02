import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { unzipSync } from "fflate"
import { format, resolveConfig } from "prettier"
import {
	BUILTIN_GUIDES,
	GUIDE_OPS,
	OP_BY_FORMULA,
	PATH_FILL_NAMES,
	PATH_NO_STROKE,
	encodeSlot,
	opArity
} from "../core/drawingml/geometry/program"
import { NodeKind, parseXml, type XmlDocument } from "../core/xml/index"

// Generates src/core/drawingml/geometry/presets.generated.ts from the preset shape definitions that ship
// with ECMA-376 Part 1 (5th edition, annex L, OfficeOpenXML-DrawingMLGeometries.zip). Every archive layer
// is checked against its pinned SHA-256.
//
//   pnpm run generate:geometry [<ECMA-376-1 zip | OfficeOpenXML-DrawingMLGeometries.zip | presetShapeDefinitions.xml>]
//
// Without an argument the Part 1 archive is downloaded from ecma-international.org.

export const OUTPUT = fileURLToPath(new URL("../core/drawingml/geometry/presets.generated.ts", import.meta.url))

export const SOURCE = {
	url: "https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip",
	sha256: "9d0bcad9cf06054785b03762fcfadbf6bab7e54a5f9d69434e34b7fd464d4129",
	geometries: "OfficeOpenXML-DrawingMLGeometries.zip",
	geometriesSha256: "a8517838a3a60492d267d1ff92e1ebd831adc04584de79a38a5532a68902abf6",
	presets: "presetShapeDefinitions.xml",
	presetsSha256: "2f7c868d857c1e3c4b5a6068759fe0e07d77ad58377a6618d1b02ba3507b6939"
} as const

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function extract(archive: Uint8Array, name: string, expected: string): Uint8Array {
	const entry = unzipSync(archive, { filter: file => file.name === name })[name]

	if (entry === undefined) throw new Error(`${name} is missing from the archive`)
	if (sha256(entry) !== expected) throw new Error(`${name} does not match its pinned SHA-256`)

	return entry
}

// The definitions file from whichever layer `bytes` is.
export function presetDefinitions(bytes: Uint8Array): Uint8Array {
	const digest = sha256(bytes)

	if (digest === SOURCE.presetsSha256) return bytes
	if (digest === SOURCE.geometriesSha256) return extract(bytes, SOURCE.presets, SOURCE.presetsSha256)
	if (digest === SOURCE.sha256) {
		return extract(extract(bytes, SOURCE.geometries, SOURCE.geometriesSha256), SOURCE.presets, SOURCE.presetsSha256)
	}

	throw new Error("Input matches none of the pinned ECMA-376 files")
}

function elements(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) out.push(child)

	return out
}

function child(document: XmlDocument, node: number, local: string): number {
	return elements(document, node).find(element => document.localName(element) === local) ?? -1
}

const INTEGER = /^-?\d+$/

// One shape element -> its encoded program; `mirrorY` turns it upside down (every y read as h - y, the text
// rectangle's top and bottom swapped). Arcs refuse: their sweeps would have to turn too.
export function encodeShape(document: XmlDocument, shape: number, mirrorY = false): string {
	const name = document.localName(shape)
	const slots = new Map<string, number>(BUILTIN_GUIDES.map((guide, index) => [guide, index]))
	let next = BUILTIN_GUIDES.length
	const argument = (token: string | undefined): string => {
		if (token === undefined) throw new Error(`${name}: missing argument`)
		if (INTEGER.test(token)) return String(Number(token))

		const slot = slots.get(token)

		if (slot === undefined) throw new Error(`${name}: unknown guide ${token}`)

		return encodeSlot(slot)
	}
	const adjust: string[] = []
	const adjustList = child(document, shape, "avLst")

	for (const gd of adjustList < 0 ? [] : elements(document, adjustList)) {
		const [op, value] = (document.attribute(gd, "fmla") ?? "").trim().split(/\s+/)
		const guide = document.attribute(gd, "name") ?? ""

		if (op !== "val" || value === undefined || !INTEGER.test(value)) throw new Error(`${name}: adjust value ${guide} is not a literal`)

		adjust.push(guide, String(Number(value)))
		slots.set(guide, next++)
	}

	const guides: string[] = []
	const guideList = child(document, shape, "gdLst")

	for (const gd of guideList < 0 ? [] : elements(document, guideList)) {
		const [formula, ...args] = (document.attribute(gd, "fmla") ?? "").trim().split(/\s+/)
		const op = OP_BY_FORMULA.get(formula ?? "")

		if (op === undefined) throw new Error(`${name}: unknown formula ${formula}`)
		// circularArrow and leftCircularArrow write "+- xH 0 dxB 0": the extra argument is dropped, as
		// every implementation reads only the first three.
		if (args.length < opArity(op)) throw new Error(`${name}: ${formula} takes ${opArity(op)} arguments`)

		guides.push(GUIDE_OPS[op]?.[1] ?? "", ...args.slice(0, opArity(op)).map(argument))
		slots.set(document.attribute(gd, "name") ?? "", next++)
	}

	const mirrored = new Map<string, string>()
	// A y as the mirror reads it: a guide h - y, added once per y.
	const y = (token: string | undefined): string => {
		if (!mirrorY) return argument(token)

		const key = token ?? ""
		let slot = mirrored.get(key)

		if (slot === undefined) {
			guides.push(GUIDE_OPS[OP_BY_FORMULA.get("+-") ?? 0]?.[1] ?? "", argument("h"), "0", argument(token))
			slot = encodeSlot(next++)
			mirrored.set(key, slot)
		}

		return slot
	}
	const rectNode = child(document, shape, "rect")
	const side = (key: string): string | undefined => document.attribute(rectNode, key) ?? (key === "l" || key === "t" ? "l" : key)
	const rect =
		rectNode < 0
			? []
			: mirrorY
				? [argument(side("l")), y(side("b")), argument(side("r")), y(side("t"))]
				: ["l", "t", "r", "b"].map(key => argument(side(key)))
	const paths: string[] = []
	const point = (pt: number): string[] => [argument(document.attribute(pt, "x")), y(document.attribute(pt, "y"))]
	const pathList = child(document, shape, "pathLst")

	for (const path of pathList < 0 ? [] : elements(document, pathList)) {
		const fill = PATH_FILL_NAMES.indexOf(document.attribute(path, "fill") ?? "norm")
		const stroke = document.attribute(path, "stroke")

		if (fill < 0) throw new Error(`${name}: unknown path fill`)

		const flags = fill | (stroke === "false" || stroke === "0" ? PATH_NO_STROKE : 0)

		paths.push(
			"P",
			String(flags),
			String(Number(document.attribute(path, "w") ?? 0)),
			String(Number(document.attribute(path, "h") ?? 0))
		)

		for (const command of elements(document, path)) {
			const pts = elements(document, command).filter(pt => document.localName(pt) === "pt")

			switch (document.localName(command)) {
				case "moveTo":
					paths.push("M", ...point(pts[0] ?? -1))
					break
				case "lnTo":
					paths.push("L", ...point(pts[0] ?? -1))
					break
				case "arcTo":
					if (mirrorY) throw new Error(`${name}: an arc cannot be mirrored`)

					paths.push("A", ...["wR", "hR", "stAng", "swAng"].map(attribute => argument(document.attribute(command, attribute))))
					break
				case "quadBezTo":
					paths.push("Q", ...point(pts[0] ?? -1), ...point(pts[1] ?? -1))
					break
				case "cubicBezTo":
					paths.push("C", ...point(pts[0] ?? -1), ...point(pts[1] ?? -1), ...point(pts[2] ?? -1))
					break
				case "close":
					paths.push("Z")
					break
				default:
					throw new Error(`${name}: unknown path command ${document.localName(command)}`)
			}
		}
	}

	return [adjust.join(" "), guides.join(" "), rect.join(" "), paths.join(" ")].join("|")
}

// The adjust values a shape's polar handles turn (a:ahPolar@gdRefAng, §20.1.9.3): angles, which a SmartArt
// layout gives in degrees (MS-OI29500 §2.1.1615).
export function angleAdjusts(document: XmlDocument, shape: number): string[] {
	const handles = child(document, shape, "ahLst")
	const adjusts = child(document, shape, "avLst")
	const names = new Set((adjusts < 0 ? [] : elements(document, adjusts)).map(gd => document.attribute(gd, "name") ?? ""))
	const out: string[] = []

	for (const handle of handles < 0 ? [] : elements(document, handles)) {
		const angle = document.localName(handle) === "ahPolar" ? document.attribute(handle, "gdRefAng") : undefined

		if (angle !== undefined && names.has(angle) && !out.includes(angle)) out.push(angle)
	}

	return out
}

export interface PresetTables {
	readonly programs: Map<string, string>
	readonly angles: Map<string, string[]>
}

export function presetTable(definitions: Uint8Array): PresetTables {
	const document = parseXml(definitions)
	const root = document.documentElement()
	const programs = new Map<string, string>()
	const angles = new Map<string, string[]>()

	for (const shape of elements(document, root)) {
		if (document.kinds[shape] !== NodeKind.Element) continue

		const name = document.localName(shape)
		const encoded = encodeShape(document, shape)

		// upDownArrow is defined twice, identically.
		if (programs.has(name) && programs.get(name) !== encoded) throw new Error(`${name} is defined twice, differently`)

		programs.set(name, encoded)

		const angle = angleAdjusts(document, shape)

		if (angle.length > 0) angles.set(name, angle)
	}

	// ECMA-376 5th edition defines upDownArrow twice and upArrow not at all. PowerPoint's upArrow is downArrow upside
	// down: LibreOffice's import of each, the latter flipped, draws the same pixels (measured).
	if (!programs.has("upArrow")) {
		const down = elements(document, root).find(shape => document.localName(shape) === "downArrow")

		if (down === undefined) throw new Error("downArrow is missing")

		programs.set("upArrow", encodeShape(document, down, true))
	}

	return { programs, angles }
}

function sorted<T>(table: ReadonlyMap<string, T>): [string, T][] {
	return [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function renderTable(tables: PresetTables): Promise<string> {
	const source = [
		`// Generated by \`pnpm run generate:geometry\` from ECMA-376 Part 1 (5th edition) ${SOURCE.presets}`,
		`// (SHA-256 ${SOURCE.presetsSha256}), © Ecma International, see THIRD_PARTY_NOTICES.md.`,
		"// Do not edit. Encoding: program.ts.",
		"",
		"export const PRESET_GEOMETRY: Readonly<Record<string, string>> = {",
		...sorted(tables.programs).map(([name, encoded]) => `\t${JSON.stringify(name)}: ${JSON.stringify(encoded)},`),
		"}",
		"",
		"// Per preset, the adjust values its polar handles turn (a:ahPolar@gdRefAng): angles.",
		"export const PRESET_ANGLE_ADJUSTS: Readonly<Record<string, readonly string[]>> = {",
		...sorted(tables.angles).map(([name, angle]) => `\t${JSON.stringify(name)}: ${JSON.stringify(angle)},`),
		"}",
		""
	].join("\n")

	return format(source, { ...(await resolveConfig(OUTPUT)), filepath: OUTPUT })
}

async function main(): Promise<void> {
	const path = process.argv[2]
	let bytes: Uint8Array

	if (path !== undefined) {
		bytes = new Uint8Array(readFileSync(path))
	} else {
		const response = await fetch(SOURCE.url)

		if (!response.ok) throw new Error(`${SOURCE.url}: HTTP ${response.status}`)

		bytes = new Uint8Array(await response.arrayBuffer())
	}

	writeFileSync(OUTPUT, await renderTable(presetTable(presetDefinitions(bytes))))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
