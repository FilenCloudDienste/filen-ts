import { DrawingList, PATH_COMMAND_COORDS, PathCommand } from "../drawingml/displayList"
import {
	appendArc,
	emitPaths,
	evaluateGuides,
	formulaAdjust,
	presetProgram,
	textRect,
	type GeometryPath
} from "../drawingml/geometry/evaluate"
import { BUILTIN_COUNT, PathFill } from "../drawingml/geometry/program"
import { EMU_PER_PX } from "../drawingml/reader"
import { PATH_ARC, PATH_CLOSE, PATH_CUBIC, PATH_LINE, PATH_MOVE, PATH_QUAD, type CustomPath } from "../presentation/model"

// A custom outline's text rectangle (a:rect), its sides numbers of EMU or guide names.
export interface CustomTextRect {
	readonly l: string
	readonly t: string
	readonly r: string
	readonly b: string
}

// An a:avLst guide: an adjust value's name and its formula.
export interface PresetGuide {
	readonly name: string
	readonly formula: string
}

// DrawingML presets (ST_ShapeType, ECMA-376 §20.1.10.56) as ODF custom shapes (ODF 1.3 Part 3 §10.6.2), for every
// ODF writer and reader: the ones an ODF draw:type draws the same as their draw:type, every other as an outline
// evaluated from its preset definition.

// Presets whose unadjusted outline the draw:type draws in LibreOffice 7.5 on any box (measured against its pptx
// import), by preset.
export const ODF_TYPES: Readonly<Record<string, string>> = {
	rect: "rectangle",
	ellipse: "ellipse",
	roundRect: "round-rectangle",
	triangle: "isosceles-triangle",
	rtTriangle: "right-triangle",
	trapezoid: "trapezoid",
	diamond: "diamond",
	octagon: "octagon",
	pentagon: "pentagon",
	star5: "star5",
	smileyFace: "smiley",
	plus: "cross",
	flowChartManualOperation: "flowchart-manual-operation"
}

// Types read as the preset they name but written evaluated: LibreOffice 7.5 draws the first two not at all and the
// others in other proportions than DrawingML's on a box that is no square (measured).
const READ_ONLY_TYPES: Readonly<Record<string, string>> = {
	cloud: "cloud",
	frame: "frame",
	parallelogram: "parallelogram",
	hexagon: "hexagon",
	rightArrow: "right-arrow",
	leftArrow: "left-arrow",
	downArrow: "down-arrow",
	upArrow: "up-arrow",
	heart: "heart",
	donut: "ring"
}

const PRESETS: ReadonlyMap<string, string> = new Map(
	[...Object.entries(ODF_TYPES), ...Object.entries(READ_ONLY_TYPES)].map(([preset, type]) => [type, preset])
)

// LibreOffice's name for a DrawingML preset it draws from the outline the file gives.
const OOXML_PREFIX = "ooxml-"

// ODF's trapezoid is DrawingML's upside down (wide at the top), its inset draw:modifiers in 21600ths of the width
// (default 5400); DrawingML's is adj 100000ths of the shorter side (default 25000, at most half the width).
const TRAPEZOID_DEFAULT = 25000
const VIEW = 21600

// EMU per 1/100 mm, the unit of an evaluated outline's view box.
const EMU_PER_HMM = 360

const scratch = new DrawingList()

function adjustOf(guides: readonly PresetGuide[], preset: string): ((name: string, slots: Float64Array) => number | undefined) | undefined {
	const program = presetProgram(preset)

	return program === undefined || guides.length === 0
		? undefined
		: formulaAdjust(new Map(guides.map(guide => [guide.name, guide.formula])), program)
}

type Attribute = readonly [string, string]

function mirrors(flipH: boolean, flipV: boolean): Attribute[] {
	return [...(flipH ? [["draw:mirror-horizontal", "true"] as const] : []), ...(flipV ? [["draw:mirror-vertical", "true"] as const] : [])]
}

// Path fill modes as LibreOffice's enhanced-path commands (F: none; H-K: darken, darkenLess, lighten, lightenLess).
const FILL_COMMAND: Readonly<Record<number, string>> = {
	[PathFill.NONE]: "F",
	[PathFill.DARKEN]: "H",
	[PathFill.DARKEN_LESS]: "I",
	[PathFill.LIGHTEN]: "J",
	[PathFill.LIGHTEN_LESS]: "K"
}

const COMMAND_LETTER: Readonly<Record<number, string>> = {
	[PathCommand.MOVE]: "M",
	[PathCommand.LINE]: "L",
	[PathCommand.CUBIC]: "C",
	[PathCommand.QUAD]: "Q",
	[PathCommand.CLOSE]: "Z"
}

// Whether odfPresetAttributes writes the preset with these guides.
export function odfWritesPreset(preset: string, guides: readonly PresetGuide[]): boolean {
	return (ODF_TYPES[preset] !== undefined && guides.length === 0) || presetProgram(preset) !== undefined
}

// Whether a preset's draw:enhanced-geometry changes with its box's size: an outline evaluated for the box, or a
// trapezoid's inset (ODF measures it on the width, DrawingML on the shorter side).
export function presetDependsOnSize(preset: string, guides: readonly PresetGuide[]): boolean {
	return preset === "trapezoid" || ODF_TYPES[preset] === undefined || guides.length > 0
}

// ODF's trapezoid modifier for a DrawingML trapezoid on `box`, to thousandths (exact through a read); undefined
// when its adjustment is outside what the type holds (0 to half the width).
function trapezoidModifier(
	program: NonNullable<ReturnType<typeof presetProgram>>,
	adjust: ((name: string, slots: Float64Array) => number | undefined) | undefined,
	box: PresetBox
): number | undefined {
	const w = Math.max(box.cx, 0)
	const ss = Math.min(w, Math.max(box.cy, 0))
	const a = evaluateGuides(program, w, box.cy, adjust)[BUILTIN_COUNT] ?? TRAPEZOID_DEFAULT

	if (!(w > 0 && ss > 0) || a < 0 || a > (50000 * w) / ss) return w > 0 && ss > 0 ? undefined : 0

	return Number(((VIEW * ss * a) / (100000 * w)).toFixed(3))
}

export interface PresetBox {
	readonly cx: number
	readonly cy: number
	readonly flipH: boolean
	readonly flipV: boolean
}

// The draw:enhanced-geometry attributes of a preset shape `cx` × `cy` EMU with `guides` (its a:avLst), mirrored by
// the flips; undefined for a name that is no preset.
export function odfPresetAttributes(preset: string, guides: readonly PresetGuide[], box: PresetBox): Attribute[] | undefined {
	const type = ODF_TYPES[preset]

	if (type !== undefined && guides.length === 0 && preset !== "trapezoid")
		return [["svg:viewBox", `0 0 ${VIEW} ${VIEW}`], ["draw:type", type], ...mirrors(box.flipH, box.flipV)]

	const program = presetProgram(preset)

	if (program === undefined) return undefined

	const adjust = adjustOf(guides, preset)

	const trapezoid = preset === "trapezoid" ? trapezoidModifier(program, adjust, box) : undefined

	// A trapezoid whose adjustment ODF's type can hold (0 to half the width); any other is evaluated below.
	if (trapezoid !== undefined) {
		const modifier = trapezoid

		return [
			["svg:viewBox", `0 0 ${VIEW} ${VIEW}`],
			["draw:type", "trapezoid"],
			["draw:modifiers", String(modifier)],
			...mirrors(box.flipH, !box.flipV)
		]
	}

	const w = Math.max(box.cx, 0)
	const h = Math.max(box.cy, 0)
	const slots = evaluateGuides(program, w, h, adjust)
	const list = scratch

	list.rewindPath(0, 0)

	const path = enhancedPath(list, emitPaths(list, program, slots, w, h))

	list.rewindPath(0, 0)

	// ECMA-376's pie writes its rect's sides swapped (t="ir" r="it"): the area is the rectangle they span.
	const [x0, y0, x1, y1] = textRect(program, slots, w, h)
	const [l, r] = x0 <= x1 ? [x0, x1] : [x1, x0]
	const [t, b] = y0 <= y1 ? [y0, y1] : [y1, y0]
	const modifiers = program.adjustNames.map((_, k) => String(Math.round(slots[BUILTIN_COUNT + k] ?? 0))).join(" ")

	return [
		["svg:viewBox", `0 0 ${Math.max(1, Math.round(w / EMU_PER_HMM))} ${Math.max(1, Math.round(h / EMU_PER_HMM))}`],
		["draw:text-areas", `${at(l)} ${at(t)} ${at(r)} ${at(b)}`],
		["draw:type", `${OOXML_PREFIX}${preset}`],
		...(modifiers === "" ? [] : [["draw:modifiers", modifiers] as const]),
		...mirrors(box.flipH, box.flipV),
		["draw:enhanced-path", path]
	]
}

// px (the drawing list's unit) as the 1/100 mm an outline's view box counts in.
function at(value: number): string {
	return String(Math.round((value * EMU_PER_PX) / EMU_PER_HMM))
}

// The paths a drawing list holds as draw:enhanced-path (ODF 1.3 Part 3 §19.145), each its own subpath set ("N") with
// its fill and stroke flags (F, S; H-K LibreOffice's darken and lighten).
function enhancedPath(list: DrawingList, paths: readonly GeometryPath[]): string {
	let path = ""

	for (const geometryPath of paths) {
		let coord = geometryPath.firstCoord

		if (path !== "") path += " "
		if (FILL_COMMAND[geometryPath.fill] !== undefined) path += `${FILL_COMMAND[geometryPath.fill]} `
		if (!geometryPath.stroke) path += "S "

		// Where the open figure began: a command after a close draws from there, which ODF says with a moveto
		// (LibreOffice draws nothing after Z until one).
		let startX = ""
		let startY = ""
		let closed = false

		for (let k = 0; k < geometryPath.commandCount; k++) {
			const command = list.commands[geometryPath.firstCommand + k] ?? PathCommand.CLOSE
			const count = PATH_COMMAND_COORDS[command] ?? 0

			if (closed && command !== PathCommand.MOVE && command !== PathCommand.CLOSE) path += `M ${startX} ${startY} `
			if (command === PathCommand.MOVE) {
				startX = at(list.coords[coord] ?? 0)
				startY = at(list.coords[coord + 1] ?? 0)
			}

			closed = command === PathCommand.CLOSE
			path += COMMAND_LETTER[command] ?? "Z"

			for (let c = 0; c < count; c++) path += ` ${at(list.coords[coord++] ?? 0)}`

			path += " "
		}

		path += "N"
	}

	return path
}

const FILL_OF: Readonly<Record<CustomPath["fill"], number>> = {
	norm: PathFill.NORM,
	none: PathFill.NONE,
	lighten: PathFill.LIGHTEN,
	lightenLess: PathFill.LIGHTEN_LESS,
	darken: PathFill.DARKEN,
	darkenLess: PathFill.DARKEN_LESS
}

// A custom outline's paths (a:custGeom read, §20.1.9.8: each in its own w × h space, or the shape's EMU) drawn for a
// `w` × `h` EMU box into `list`, in px, as the preset paths are (emitPaths): arcs as cubics, their angles measured in
// the path's own space.
function customPaths(list: DrawingList, paths: readonly CustomPath[], w: number, h: number): GeometryPath[] {
	const out: GeometryPath[] = []
	const end: [number, number] = [0, 0]

	for (const path of paths) {
		const sx = (path.w > 0 ? w / path.w : 1) / EMU_PER_PX
		const sy = (path.h > 0 ? h / path.h : 1) / EMU_PER_PX
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount
		const coords = path.coords
		let at = 0
		let x = 0
		let y = 0
		let startX = 0
		let startY = 0
		let started = false
		let open = true
		const start = (): void => {
			if (!started) list.moveTo(x, y)

			started = true
		}

		for (const command of path.commands) {
			switch (command) {
				case PATH_MOVE:
					x = (coords[at++] ?? 0) * sx
					y = (coords[at++] ?? 0) * sy
					startX = x
					startY = y
					list.moveTo(x, y)
					started = true
					break
				case PATH_LINE:
					start()
					x = (coords[at++] ?? 0) * sx
					y = (coords[at++] ?? 0) * sy
					list.lineTo(x, y)
					break
				case PATH_CUBIC: {
					start()

					const [x1, y1, x2, y2, x3, y3] = [0, 1, 2, 3, 4, 5].map(k => (coords[at + k] ?? 0) * (k % 2 === 0 ? sx : sy)) as [
						number,
						number,
						number,
						number,
						number,
						number
					]

					at += 6
					list.cubicTo(x1, y1, x2, y2, x3, y3)
					x = x3
					y = y3
					break
				}
				case PATH_QUAD: {
					start()

					const [x1, y1, x2, y2] = [0, 1, 2, 3].map(k => (coords[at + k] ?? 0) * (k % 2 === 0 ? sx : sy)) as [
						number,
						number,
						number,
						number
					]

					at += 4
					list.quadTo(x1, y1, x2, y2)
					x = x2
					y = y2
					break
				}
				case PATH_ARC: {
					start()

					const wR = coords[at] ?? 0
					const hR = coords[at + 1] ?? 0

					appendArc(
						list,
						x,
						y,
						Math.abs(wR * sx),
						Math.abs(hR * sy),
						coords[at + 2] ?? 0,
						coords[at + 3] ?? 0,
						end,
						Math.abs(wR),
						Math.abs(hR)
					)
					at += 4
					x = end[0]
					y = end[1]
					break
				}
				case PATH_CLOSE:
					if (started) list.close()

					open = false
					x = startX
					y = startY
					break
				default:
					break
			}
		}

		const commandCount = list.commandCount - firstCommand

		if (commandCount > 0) out.push({ firstCommand, firstCoord, commandCount, fill: FILL_OF[path.fill], stroke: path.stroke, open })
	}

	return out
}

// The draw:enhanced-geometry attributes of a custom outline (a:custGeom read) on a `cx` × `cy` EMU box, mirrored by the
// flips: its paths drawn for the box, its text area where the outline puts it (else the whole box).
export function odfCustomAttributes(paths: readonly CustomPath[], textRect: CustomTextRect | undefined, box: PresetBox): Attribute[] {
	const w = Math.max(box.cx, 0)
	const h = Math.max(box.cy, 0)
	const list = scratch

	list.rewindPath(0, 0)

	const path = enhancedPath(list, customPaths(list, paths, w, h))

	list.rewindPath(0, 0)

	const side = (value: string | undefined, whole: number): number => {
		const number = Number(value)

		return value !== undefined && value !== "" && Number.isFinite(number) ? number / EMU_PER_PX : whole
	}
	const area =
		textRect === undefined
			? []
			: ([
					[
						"draw:text-areas",
						`${at(side(textRect.l, 0))} ${at(side(textRect.t, 0))} ${at(side(textRect.r, w / EMU_PER_PX))} ${at(side(textRect.b, h / EMU_PER_PX))}`
					]
				] as const)

	return [
		["svg:viewBox", `0 0 ${Math.max(1, Math.round(w / EMU_PER_HMM))} ${Math.max(1, Math.round(h / EMU_PER_HMM))}`],
		...area,
		["draw:type", "non-primitive"],
		...mirrors(box.flipH, box.flipV),
		["draw:enhanced-path", path]
	]
}

// The commands a custom outline reads back as from what odfCustomAttributes writes (the ODF reader's moveto, lineto,
// curveto and close: a quadratic and an arc as cubics, a moveto after a close that a command follows), with its fill
// as ODF holds it (filled or not): what a written outline is compared by.
export function odfCustomCommands(path: CustomPath): { readonly commands: number[]; readonly filled: boolean } {
	const list = new DrawingList()
	const [written] = customPaths(list, [path], 1, 1)
	const commands: number[] = []
	let closed = false

	for (let k = 0; k < (written?.commandCount ?? 0); k++) {
		const command = list.commands[k] ?? PathCommand.CLOSE

		if (closed && command !== PathCommand.MOVE && command !== PathCommand.CLOSE) commands.push(PATH_MOVE)

		closed = command === PathCommand.CLOSE
		commands.push(
			command === PathCommand.MOVE
				? PATH_MOVE
				: command === PathCommand.LINE
					? PATH_LINE
					: command === PathCommand.CLOSE
						? PATH_CLOSE
						: PATH_CUBIC
		)
	}

	return { commands, filled: path.fill !== "none" }
}

// odfPresetAttributes as a draw:enhanced-geometry element (the values are numbers and preset names: nothing to escape).
export function odfPresetGeometry(preset: string, guides: readonly PresetGuide[], box: PresetBox): string | undefined {
	const attributes = odfPresetAttributes(preset, guides, box)

	return attributes === undefined
		? undefined
		: `<draw:enhanced-geometry${attributes.map(([name, value]) => ` ${name}="${value}"`).join("")}/>`
}

// The preset an ODF draw:type names (with its draw:modifiers for a `w` × `h` shape, any unit), and whether its
// draw:mirror-vertical reads inverted; undefined for a type that is none.
export function presetOfOdfType(
	type: string,
	modifiers: readonly number[],
	w: number,
	h: number
): { readonly preset: string; readonly guides: readonly PresetGuide[]; readonly invertsV: boolean } | undefined {
	if (type.startsWith(OOXML_PREFIX)) {
		const preset = type.slice(OOXML_PREFIX.length)
		const program = presetProgram(preset)

		if (program === undefined) return undefined

		const guides: PresetGuide[] = []

		for (let k = 0; k < program.adjustNames.length && k < modifiers.length; k++) {
			const value = Math.round(modifiers[k] ?? 0)

			if (Number.isFinite(value) && value !== program.adjustDefaults[k])
				guides.push({ name: program.adjustNames[k] as string, formula: `val ${value}` })
		}

		return { preset, guides, invertsV: false }
	}

	const preset = PRESETS.get(type)

	if (preset === undefined) return undefined
	if (preset !== "trapezoid") return { preset, guides: [], invertsV: false }

	const ss = Math.min(w, h)
	const modifier = modifiers[0] ?? VIEW / 4
	const adj = ss > 0 && Number.isFinite(modifier) ? Math.round((modifier * 100000 * w) / (VIEW * ss)) : TRAPEZOID_DEFAULT

	return { preset, guides: adj === TRAPEZOID_DEFAULT ? [] : [{ name: "adj", formula: `val ${adj}` }], invertsV: true }
}
