import { D } from "../reader"
import { plainParagraph, readTextBody, type TextDefaults } from "../text"
import { ChartBuilder, PX_PER_PT, estimateHeight, estimateWidth, labelBody, type Rect } from "./builder"
import { formatNumber } from "./format"
import type { Axis } from "./model"
import { mutedText } from "./palette"
import { scaleFraction, scaleTicks, type Scale } from "./scale"

// An axis prepared for drawing: its scale or categories, labels and, once laid out, its pixel span.
export interface AxisState {
	readonly axis: Axis
	horizontal: boolean
	// Value axes.
	scale: Scale | undefined
	format: string
	// Category axes: point count and whether points sit in bands (bars) or on the band edges.
	count: number
	between: boolean
	categories: string[]
	text: TextDefaults
	rotation: number
	// The labels' rotation is not written (c:txPr a:bodyPr@rot): crowded category labels may wrap or turn.
	autoRotate: boolean
	// Crowded category labels broken into lines this wide (px) at word boundaries; 0 when they are not.
	wrap: number
	// Pixel span along the axis direction (from = minimum, after orientation).
	from: number
	to: number
	// The cross position (px on the other direction) where the axis line runs.
	line: number
	used: boolean
}

export function axisState(axis: Axis, text: TextDefaults, rotation: number, autoRotate: boolean = false): AxisState {
	return {
		axis,
		horizontal: axis.side === "b" || axis.side === "t",
		scale: undefined,
		format: "General",
		count: 0,
		between: true,
		categories: [],
		text,
		rotation,
		autoRotate,
		wrap: 0,
		from: 0,
		to: 0,
		line: 0,
		used: false
	}
}

export function setSpan(state: AxisState, inner: Rect): void {
	const reversed = state.axis.reversed

	if (state.horizontal) {
		state.from = reversed ? inner.x + inner.w : inner.x
		state.to = reversed ? inner.x : inner.x + inner.w
	} else {
		state.from = reversed ? inner.y : inner.y + inner.h
		state.to = reversed ? inner.y + inner.h : inner.y
	}
}

export function valuePosition(state: AxisState, value: number): number {
	const scale = state.scale

	if (scale === undefined) return state.from

	return state.from + (state.to - state.from) * scaleFraction(scale, value)
}

// Centre of category `index` (0-based).
export function categoryPosition(state: AxisState, index: number): number {
	const count = Math.max(1, state.count)

	if (state.between) return state.from + ((index + 0.5) * (state.to - state.from)) / count
	if (count === 1) return (state.from + state.to) / 2

	return state.from + (index * (state.to - state.from)) / (count - 1)
}

// Signed width of one category band.
export function categoryBand(state: AxisState): number {
	const count = Math.max(1, state.count)

	return (state.to - state.from) / (state.between || count === 1 ? count : count - 1)
}

// Position along an axis for a value or a category number (scatter x on a category axis).
export function axisPosition(state: AxisState, value: number): number {
	return state.scale === undefined ? categoryPosition(state, value) : valuePosition(state, value)
}

// The value where a perpendicular axis crosses this value axis, clamped into the scale.
export function crossingValue(state: AxisState, crossing: Axis): number {
	const scale = state.scale

	if (scale === undefined) return 0

	let value: number

	if (crossing.crosses === "min") value = scale.min
	else if (crossing.crosses === "max") value = scale.max
	else if (crossing.crossesAt !== undefined) value = crossing.crossesAt
	else value = scale.logBase > 1 ? scale.min : 0

	return Math.min(scale.max, Math.max(scale.min, value))
}

// Pixel coordinate where `axis` (crossing `cross`) draws its line.
export function crossingPosition(cross: AxisState, axis: Axis): number {
	if (cross.scale !== undefined) return valuePosition(cross, crossingValue(cross, axis))
	if (axis.crosses === "max") return cross.to
	if (axis.crossesAt !== undefined && axis.crosses !== "min") return categoryPosition(cross, axis.crossesAt - 1)

	return cross.from
}

export function tickLabels(state: AxisState): string[] {
	if (state.scale === undefined) return state.categories

	return scaleTicks(state.scale).map(value => formatNumber(value, state.format))
}

const NARROW = new Set("ilIjtfr.,:;!|'`\"()[]{}/\\- 1")
const WIDE = new Set("mwMW@%")

// A label's width (px) at `size` pt in a proportional sans face like Office's default Calibri, by character class
// (narrow, wide, capital, other), closer than estimateWidth's monospaced guess: whether labels fit decides whether
// they turn.
function proportionalWidth(text: string, size: number): number {
	let em = 0
	let longest = 0

	for (const char of text) {
		if (char === "\n") {
			longest = Math.max(longest, em)
			em = 0
		} else if (NARROW.has(char)) em += 0.25
		else if (WIDE.has(char)) em += 0.8
		else if ((char.codePointAt(0) ?? 0) >= 0x2e80) em += 1
		else if (char >= "A" && char <= "Z") em += 0.6
		else em += 0.5
	}

	return Math.max(longest, em) * size * PX_PER_PT
}

// Lines a wrapped label takes beyond this are not worth it: the labels turn instead.
const MAX_WRAPPED_LINES = 3

// `label` broken at spaces into lines no wider than `width` (px) where its words allow.
function wrapLabel(label: string, size: number, width: number): string[] {
	const lines: string[] = []
	let line = ""

	for (const word of label.split(" ")) {
		const candidate = line === "" ? word : `${line} ${word}`

		if (line !== "" && proportionalWidth(candidate, size) > width) {
			lines.push(line)
			line = word
		} else line = candidate
	}

	lines.push(line)

	return lines
}

// Category labels across the bottom or top that do not fit their bands side by side, when the file leaves their
// rotation automatic, are drawn as LibreOffice draws them (PowerPoint documents no rule): broken into lines at spaces
// when every word fits its band, else turned 45° (counterclockwise, ending at their ticks); thinning follows only when
// even turned they overlap. `length` is the axis length (px), estimated.
export function autoRotateLabels(state: AxisState, length: number): void {
	if (!state.autoRotate || !state.horizontal || state.scale !== undefined || state.axis.labelSkip > 0 || state.count <= 0) return

	const band = (length / Math.max(1, state.between ? state.count : state.count - 1)) * 0.95
	const size = state.text.size
	let widest = 0
	let widestWord = 0
	let lines = 1

	for (const label of state.categories) widest = Math.max(widest, proportionalWidth(label, size))

	state.rotation = 0
	state.wrap = 0

	if (widest <= band) return

	for (const label of state.categories) {
		for (const word of label.split(" ")) widestWord = Math.max(widestWord, proportionalWidth(word, size))

		if (widestWord > band) break

		lines = Math.max(lines, wrapLabel(label, size, band).length)
	}

	if (widestWord <= band && lines <= MAX_WRAPPED_LINES) state.wrap = band
	else state.rotation = -45
}

// A label's width as the axis lays it out: a proportional estimate where the axis fits crowded category labels
// itself (horizontal, rotation automatic), the plain estimate elsewhere.
function labelWidth(state: AxisState, label: string): number {
	return state.autoRotate && state.horizontal && state.scale === undefined
		? proportionalWidth(label, state.text.size)
		: estimateWidth(label, state.text.size)
}

// The lines of a horizontal axis label: its wrapped lines, else itself.
function labelLines(state: AxisState, label: string): string[] {
	return state.wrap > 0 && state.horizontal && state.rotation === 0 ? wrapLabel(label, state.text.size, state.wrap) : [label]
}

// Space the axis's labels and title take beside the plot (px), estimated.
export function axisExtent(builder: ChartBuilder, state: AxisState): number {
	const axis = state.axis

	if (!state.used || axis.deleted) return 0

	let extent = 0

	if (axis.labelPosition !== "none") {
		const labels = tickLabels(state)
		let widest = 0
		let lines = 1

		for (const label of labels) {
			widest = Math.max(widest, labelWidth(state, label))
			lines = Math.max(lines, labelLines(state, label).length)
		}

		const tall = estimateHeight(state.text.size, lines)
		const radians = (Math.abs(state.rotation) * Math.PI) / 180
		const rotatedHeight = Math.abs(Math.sin(radians)) * widest + Math.abs(Math.cos(radians)) * tall
		const rotatedWidth = Math.abs(Math.cos(radians)) * widest + Math.abs(Math.sin(radians)) * tall

		extent = (state.horizontal ? rotatedHeight : rotatedWidth) + 6
	}

	if (axis.title >= 0)
		extent += estimateHeight(builder.textProps(builder.reader.child(axis.title, D.C, "txPr"), { ...builder.text, bold: true }).size) + 4

	return extent
}

// Major gridlines across the plot.
export function drawGridlines(builder: ChartBuilder, state: AxisState, inner: Rect): void {
	const axis = state.axis

	if (!state.used || axis.majorGridlines < 0) return

	const reader = builder.reader
	const stroke = builder.line(reader.child(axis.majorGridlines, D.C, "spPr"), {
		color: mutedText(builder.theme, 0.15),
		width: 1,
		round: false
	})

	if (stroke < 0) return

	const positions: number[] = []

	if (state.scale !== undefined) {
		for (const tick of scaleTicks(state.scale)) positions.push(valuePosition(state, tick))
	} else {
		const band = categoryBand(state)
		const step = Math.max(1, Math.ceil(2 / Math.max(1e-6, Math.abs(band))))

		if (state.between) for (let k = 0; k <= state.count; k += step) positions.push(state.from + k * band)
		else for (let k = 0; k < state.count; k += step) positions.push(categoryPosition(state, k))
	}

	builder.begin()

	for (const position of positions) {
		if (state.horizontal) builder.segment(position, inner.y, position, inner.y + inner.h)
		else builder.segment(inner.x, position, inner.x + inner.w, position)
	}

	builder.end(-1, stroke, inner, 0, axis.node)
}

// The axis line with its tick marks.
export function drawAxisLine(builder: ChartBuilder, state: AxisState): void {
	const axis = state.axis

	if (!state.used || axis.deleted) return

	const stroke = builder.line(axis.spPr, { color: mutedText(builder.theme, 0.25), width: 1, round: false })

	if (stroke < 0) return

	const outward = axis.side === "b" || axis.side === "r" ? 1 : -1
	const tick = 4
	const [low, high] =
		axis.majorTick === "out" ? [0, tick] : axis.majorTick === "in" ? [-tick, 0] : axis.majorTick === "cross" ? [-tick, tick] : [0, 0]

	builder.begin()

	if (state.horizontal) builder.segment(state.from, state.line, state.to, state.line)
	else builder.segment(state.line, state.from, state.line, state.to)

	if (low !== high) {
		const positions: number[] = []

		if (state.scale !== undefined) {
			for (const value of scaleTicks(state.scale)) positions.push(valuePosition(state, value))
		} else {
			const band = categoryBand(state)
			// Below 2px per category, ticks would merge into a bar: every n-th is kept.
			const step = Math.max(1, Math.ceil(2 / Math.max(1e-6, Math.abs(band))))

			for (let k = 0; k <= (state.between ? state.count : state.count - 1); k += step) positions.push(state.from + k * band)
		}

		for (const position of positions) {
			if (state.horizontal) builder.segment(position, state.line + low * outward, position, state.line + high * outward)
			else builder.segment(state.line + low * outward, position, state.line + high * outward, position)
		}
	}

	const box: Rect = state.horizontal
		? { x: Math.min(state.from, state.to), y: state.line - tick, w: Math.abs(state.to - state.from), h: tick * 2 }
		: { x: state.line - tick, y: Math.min(state.from, state.to), w: tick * 2, h: Math.abs(state.to - state.from) }

	builder.end(-1, stroke, box, 0, axis.node)
}

// Tick labels one axis draws.
const MAX_TICK_LABELS = 1000

// Tick labels and the axis title. `inner` is the plot rectangle (for "low"/"high" label positions).
export function drawAxisLabels(builder: ChartBuilder, state: AxisState, inner: Rect): void {
	const axis = state.axis

	if (!state.used || axis.deleted) return

	const size = state.text.size
	const tall = estimateHeight(size)
	const gap = axis.majorTick === "out" || axis.majorTick === "cross" ? 6 : 3
	let line = state.line

	if (axis.labelPosition === "low") line = state.horizontal ? inner.y + inner.h : inner.x
	if (axis.labelPosition === "high") line = state.horizontal ? inner.y : inner.x + inner.w

	const before = axis.labelPosition === "high" ? axis.side === "b" || axis.side === "r" : axis.side === "t" || axis.side === "l"
	let extent = 0

	if (axis.labelPosition !== "none") {
		const labels = tickLabels(state)
		const positions =
			state.scale === undefined
				? labels.map((_, k) => categoryPosition(state, k))
				: scaleTicks(state.scale).map(value => valuePosition(state, value))
		const band = Math.abs(
			state.scale === undefined ? categoryBand(state) : positions.length > 1 ? (positions[1] ?? 0) - (positions[0] ?? 0) : 100
		)
		let widest = 0
		let lineCount = 1

		for (const label of labels) {
			widest = Math.max(widest, state.wrap > 0 ? Math.min(state.wrap, labelWidth(state, label)) : labelWidth(state, label))
			lineCount = Math.max(lineCount, labelLines(state, label).length)
		}

		// Category labels that would overlap are thinned, as Office does when it cannot rotate them.
		// Never more than MAX_TICK_LABELS, whatever the skip says.
		const radians = (Math.abs(state.rotation) * Math.PI) / 180
		const cos = Math.abs(Math.cos(radians))
		const sin = Math.abs(Math.sin(radians))
		// Along a horizontal category axis, a label takes its width when level, and its line height over the sine
		// when turned.
		const across = state.rotation === 0 ? widest : sin > 1e-6 ? tall / sin : widest
		const skip = Math.max(
			Math.ceil(labels.length / MAX_TICK_LABELS),
			axis.labelSkip > 0
				? axis.labelSkip
				: state.scale === undefined && state.horizontal
					? Math.max(1, Math.ceil(across / Math.max(1, band * 0.95)))
					: 1
		)

		labels.forEach((label, index) => {
			if (label === "" || index % skip !== 0) return

			const position = positions[index] ?? 0
			const width = Math.max(band, estimateWidth(label, size) + 4)
			const paragraph = plainParagraph(label, state.text, state.horizontal ? "ctr" : before ? "r" : "l")

			if (state.horizontal && state.rotation === 0) {
				const rows = labelLines(state, label)
				const height = estimateHeight(size, rows.length)
				const y = before ? line - gap - height : line + gap

				builder.label(
					rows.map(row => plainParagraph(row, state.text, "ctr")),
					{ x: position - width / 2, y, w: width, h: height },
					labelBody(before ? "b" : "t", 0),
					axis.node
				)
			} else if (state.horizontal) {
				// A turned label laid out level in its own box, turned about the box's centre: its end (counterclockwise) or
				// start (clockwise) at the tick, away from the axis.
				const length = labelWidth(state, label) + 4
				const toward = state.rotation < 0 ? -1 : 1
				const cx = position + (toward * length * cos) / 2
				const reach = (length * sin) / 2 + (tall * cos) / 2
				const cy = before ? line - gap - reach : line + gap + reach

				builder.label(
					[paragraph],
					{ x: cx - length / 2, y: cy - tall / 2, w: length, h: tall },
					labelBody("ctr", state.rotation),
					axis.node
				)
			} else {
				const labelWidth = estimateWidth(label, size) + 4
				const x = before ? line - gap - labelWidth : line + gap

				builder.label(
					[paragraph],
					{ x, y: position - tall / 2, w: labelWidth, h: tall },
					labelBody("ctr", state.rotation),
					axis.node
				)
			}
		})

		extent = state.horizontal ? sin * widest + cos * estimateHeight(size, lineCount) : widest + 4
	}

	if (axis.title >= 0) drawAxisTitle(builder, state, line, before, gap + extent + 4)
}

function drawAxisTitle(builder: ChartBuilder, state: AxisState, line: number, before: boolean, offset: number): void {
	const axis = state.axis
	const reader = builder.reader
	const defaults = builder.textProps(reader.child(axis.title, D.C, "txPr"), { ...builder.text, bold: true })
	const rich = reader.child(reader.child(axis.title, D.C, "tx"), D.C, "rich")
	const ref = reader.child(axis.title, D.C, "tx")
	const tall = estimateHeight(defaults.size)
	let paragraphs
	let rotation = state.horizontal ? 0 : -90

	if (rich >= 0) {
		const body = readTextBody(reader, builder.theme, rich, defaults)
		const listAlign = reader.attr(reader.child(reader.child(rich, D.A, "lstStyle"), D.A, "lvl1pPr"), "algn")
		const written = reader
			.children(rich, D.A, "p")
			.map(p => listAlign !== undefined || reader.attr(reader.child(p, D.A, "pPr"), "algn") !== undefined)

		// A title paragraph with no alignment written is centred along the axis, as Office draws it.
		paragraphs = body.paragraphs.map((paragraph, k) => (written[k] === true ? paragraph : { ...paragraph, align: "ctr" as const }))
		rotation = builder.textRotation(rich) ?? rotation
	} else {
		const text = reader.text(reader.child(reader.child(reader.child(ref, D.C, "strRef"), D.C, "strCache"), D.C, "pt"))

		paragraphs = [plainParagraph(text === "" ? "Axis Title" : text.trim(), defaults)]
	}

	const middle = (state.from + state.to) / 2
	const length = Math.abs(state.to - state.from)

	if (state.horizontal) {
		const y = before ? line - offset - tall : line + offset

		builder.label(paragraphs, { x: middle - length / 2, y, w: length, h: tall }, labelBody(before ? "b" : "t", rotation), axis.title)
	} else {
		// A rotated title: the box is the unrotated text box centred where the title goes.
		const x = before ? line - offset - tall / 2 : line + offset + tall / 2

		builder.label(paragraphs, { x: x - length / 2, y: middle - tall / 2, w: length, h: tall }, labelBody("ctr", rotation), axis.title)
	}
}
