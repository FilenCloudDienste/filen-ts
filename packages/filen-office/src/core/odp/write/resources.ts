import { patternMask } from "../../drawingml/canvas"
import { encodePng } from "../../metafile/dib"
import type { ColorModel, FillProps, LineEnd, LineProps } from "../../presentation/model"
import { escapeAttribute } from "../../xml/index"
import { alphaOf, cm, hexColor, isRefused, percent, setProperty, type StyleChanges } from "./styles"

// The drawing resources a new package's office:styles holds (ODF 1.3 Part 3 §16.40 draw:gradient, §16.42
// draw:fill-image, §16.43 draw:stroke-dash, §16.44 draw:opacity, §16.45 draw:marker), written from DrawingML fills
// and lines with sRGB colours (the fresh writer resolves them first): each distinct one once, named in the order
// written. What ODF cannot hold as DrawingML has it is written in the nearest form and named in `approximated`.
// The inverse of read/fills.ts, whose mapping it follows.

export interface DrawResourceSink {
	// A resource element with these attributes (draw:name added), its name; the same element once.
	named(element: "draw:gradient" | "draw:opacity" | "draw:fill-image" | "draw:marker" | "draw:stroke-dash", attributes: string): string
	// A picture of the package (a pattern's tile), its path; the same bytes once.
	picture(bytes: Uint8Array, extension: string): string
	// A picture fill's part copied into the package, its path (undefined when the part is not there).
	part(part: string): string | undefined
	// What was written in a nearer form, by what.
	approximated(what: string): void
}

export class DrawResources implements DrawResourceSink {
	private readonly elements = new Map<string, string>()
	private readonly pictures = new Map<string, string>()
	private readonly parts: (part: string) => string | undefined
	private readonly add: (path: string, bytes: Uint8Array) => void
	private readonly note: (what: string) => void
	private markup = ""

	constructor(parts: (part: string) => string | undefined, add: (path: string, bytes: Uint8Array) => void, note: (what: string) => void) {
		this.parts = parts
		this.add = add
		this.note = note
	}

	named(element: Parameters<DrawResourceSink["named"]>[0], attributes: string): string {
		const key = `${element} ${attributes}`
		const held = this.elements.get(key)

		if (held !== undefined) return held

		const name = `${element.slice(5).replace(/-./gu, part => (part[1] ?? "").toUpperCase())}${String(this.elements.size + 1)}`

		this.elements.set(key, name)
		this.markup += `<${element} draw:name="${name}"${attributes}/>`

		return name
	}

	picture(bytes: Uint8Array, extension: string): string {
		let key = String(bytes.length)

		for (const byte of bytes) key += `,${String(byte)}`

		const held = this.pictures.get(key)

		if (held !== undefined) return held

		const path = `Pictures/tile${String(this.pictures.size + 1)}.${extension}`

		this.pictures.set(key, path)
		this.add(path, bytes)

		return path
	}

	part(part: string): string | undefined {
		return this.parts(part)
	}

	approximated(what: string): void {
		this.note(what)
	}

	// The elements written, for office:styles.
	styles(): string {
		return this.markup
	}
}

function hex(color: ColorModel): string {
	const written = hexColor(color)

	return isRefused(written) ? "#000000" : written
}

function degrees(value: number): string {
	const normalized = ((value % 360) + 360) % 360

	return `${String(Math.round(normalized * 10) / 10)}deg`
}

// A gradient (§20.1.8.33 a:gradFill) as draw:gradient: two stops as start and end, three mirrored ones (A, B, A at 0,
// ½, 1) as axial, a circle path as radial from its fill-to centre (the last stop outside, the first at the centre), a
// rect or shape path as rectangular. ODF has two colours: more stops keep their ends. draw:border is the share of
// the start colour before the blend. Stops of one alpha are draw:opacity; of several, an opacity gradient.
function gradientChanges(
	changes: StyleChanges,
	fill: Extract<FillProps, { kind: "gradient" }>,
	sink: DrawResourceSink,
	family: string
): void {
	const stops = [...fill.stops].sort((a, b) => a.pos - b.pos)
	const first = stops[0]
	const last = stops[stops.length - 1]

	if (first === undefined || last === undefined) return

	const mirrored =
		stops.length === 3 &&
		first.pos === 0 &&
		last.pos === 100_000 &&
		stops[1]?.pos === 50_000 &&
		hex(first.color) === hex(last.color) &&
		alphaOf(first.color) === alphaOf(last.color)

	if (stops.length > 2 && !mirrored) sink.approximated("gradient of more than two stops")

	let style: string
	let start: ColorModel
	let end: ColorModel
	let border = 0
	let geometry = ""

	if (fill.path !== undefined) {
		// Outside in: ODF's start colour is the outer one.
		start = last.color
		end = first.color
		style = fill.path.shape === "circle" ? "radial" : "rectangular"
		border = 100_000 - last.pos

		if (fill.path.shape === "shape") sink.approximated("gradient along the shape's outline")

		const cx = Math.min(100_000, Math.max(0, fill.path.fillTo.l))
		const cy = Math.min(100_000, Math.max(0, fill.path.fillTo.t))

		geometry = ` draw:cx="${percent(cx / 1000)}" draw:cy="${percent(cy / 1000)}"`
	} else {
		const angle = fill.linear === undefined ? 0 : fill.linear.angle / 60_000

		if (mirrored) {
			style = "axial"
			start = first.color
			end = stops[1]?.color ?? last.color
		} else {
			style = "linear"
			start = first.color
			end = last.color
			border = first.pos
		}

		// ODF's 0° runs top to bottom and turns counter-clockwise; DrawingML's 0° left to right, clockwise.
		geometry = ` draw:angle="${degrees(90 - angle)}"`
	}

	const attributes =
		` draw:style="${style}"${geometry} draw:start-color="${hex(start)}" draw:end-color="${hex(end)}"` +
		` draw:start-intensity="100%" draw:end-intensity="100%" draw:border="${percent(Math.min(100_000, Math.max(0, border)) / 1000)}"`

	setProperty(changes, family, "draw:fill", "gradient")
	setProperty(changes, family, "draw:fill-gradient-name", sink.named("draw:gradient", attributes))

	const startAlpha = alphaOf(start)
	const endAlpha = alphaOf(end)

	if (startAlpha === endAlpha) {
		setProperty(changes, family, "draw:opacity", percent(startAlpha / 1000))
		setProperty(changes, family, "draw:opacity-name", null)
	} else {
		const opacity = attributes
			.replace(/ draw:start-color="[^"]*" draw:end-color="[^"]*" draw:start-intensity="[^"]*" draw:end-intensity="[^"]*"/u, "")
			.concat(` draw:start="${percent(startAlpha / 1000)}" draw:end="${percent(endAlpha / 1000)}"`)

		setProperty(changes, family, "draw:opacity", null)
		setProperty(changes, family, "draw:opacity-name", sink.named("draw:opacity", opacity))
	}
}

// PowerPoint draws a pattern's 8 × 8 cells one device pixel each: at 96 dpi, 8 px.
const TILE = cm((8 / 96) * 914_400)

// A preset pattern (§20.1.8.47 a:pattFill, §20.1.10.51) as its 8 × 8 tile in the foreground and background colours,
// repeated (§16.42 draw:fill-image, §20.236 style:repeat). A preset drawn as the blend of its colours is their mix.
function patternChanges(
	changes: StyleChanges,
	fill: Extract<FillProps, { kind: "pattern" }>,
	sink: DrawResourceSink,
	family: string
): void {
	const mask = patternMask(fill.preset)
	const rgba = (color: ColorModel): [number, number, number, number] => {
		const value = parseInt(hex(color).slice(1), 16)

		return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, Math.round((alphaOf(color) / 100_000) * 255)]
	}
	const fg = rgba(fill.fg)
	const bg = rgba(fill.bg)

	if (mask === undefined) {
		sink.approximated(`pattern ${fill.preset}`)

		const mix = fg.map((value, index) => Math.round((value + (bg[index] ?? 0)) / 2))

		setProperty(changes, family, "draw:fill", "solid")
		setProperty(
			changes,
			family,
			"draw:fill-color",
			`#${mix
				.slice(0, 3)
				.map(value => value.toString(16).padStart(2, "0"))
				.join("")}`
		)
		setProperty(changes, family, "draw:opacity", percent(((mix[3] ?? 255) / 255) * 100))

		return
	}

	const pixels = new Uint8Array(64 * 4)

	for (let index = 0; index < 64; index++) pixels.set(mask[index] === 1 ? fg : bg, index * 4)

	const path = sink.picture(encodePng(pixels, 8, 8), "png")
	const name = sink.named(
		"draw:fill-image",
		` xlink:href="${escapeAttribute(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"`
	)

	setProperty(changes, family, "draw:fill", "bitmap")
	setProperty(changes, family, "draw:fill-image-name", name)
	setProperty(changes, family, "style:repeat", "repeat")
	setProperty(changes, family, "draw:fill-image-width", TILE)
	setProperty(changes, family, "draw:fill-image-height", TILE)
	setProperty(changes, family, "draw:opacity", null)
}

// A picture fill (§20.1.8.14 a:blipFill) as draw:fill-image: stretched, or tiled at its scale. A crop or a tile's
// offset, flip and alignment have no ODF form.
function pictureChanges(
	changes: StyleChanges,
	fill: Extract<FillProps, { kind: "picture" }>,
	sink: DrawResourceSink,
	family: string
): boolean {
	const path = fill.part === undefined ? undefined : sink.part(fill.part)

	if (path === undefined) return false

	const name = sink.named(
		"draw:fill-image",
		` xlink:href="${escapeAttribute(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"`
	)
	const crop = fill.crop
	const stretch = fill.stretch

	if (
		(crop !== undefined && (crop.l !== 0 || crop.t !== 0 || crop.r !== 0 || crop.b !== 0)) ||
		(stretch !== undefined && (stretch.l !== 0 || stretch.t !== 0 || stretch.r !== 0 || stretch.b !== 0))
	)
		sink.approximated("cropped picture fill")

	setProperty(changes, family, "draw:fill", "bitmap")
	setProperty(changes, family, "draw:fill-image-name", name)

	if (fill.tile === undefined) {
		setProperty(changes, family, "style:repeat", "stretch")
	} else {
		if (fill.tile.tx !== 0 || fill.tile.ty !== 0 || fill.tile.flip !== "none" || fill.tile.algn !== "tl")
			sink.approximated("tiled picture fill")

		setProperty(changes, family, "style:repeat", "repeat")
		setProperty(changes, family, "draw:fill-image-width", percent(fill.tile.sx / 1000))
		setProperty(changes, family, "draw:fill-image-height", percent(fill.tile.sy / 1000))
	}

	setProperty(changes, family, "draw:opacity", null)

	return true
}

// A fill ODF holds only through a drawing resource, written: true; false for a fill this does not write (solid and
// none are the style's own, fillChanges).
// `family`: the properties' (graphic for a shape, drawing-page for a page's background).
export function resourceFillChanges(changes: StyleChanges, fill: FillProps, sink: DrawResourceSink, family = "graphic"): boolean {
	switch (fill.kind) {
		case "gradient":
			gradientChanges(changes, fill, sink, family)

			return true
		case "pattern":
			patternChanges(changes, fill, sink, family)

			return true
		case "picture":
			return pictureChanges(changes, fill, sink, family)
		default:
			return false
	}
}

// ST_PresetLineDashVal (§20.1.10.48) in line widths: each dash then its space.
const DASHES: Readonly<Record<string, readonly number[]>> = {
	dot: [1, 3],
	dash: [4, 3],
	lgDash: [8, 3],
	dashDot: [4, 3, 1, 3],
	lgDashDot: [8, 3, 1, 3],
	lgDashDotDot: [8, 3, 1, 3, 1, 3],
	sysDash: [3, 1],
	sysDot: [1, 1],
	sysDashDot: [3, 1, 1, 1],
	sysDashDotDot: [3, 1, 1, 1, 1, 1]
}

// A dash pattern (in line widths, dash and space pairs) as draw:stroke-dash: up to two runs of equal dashes and one
// space between all (§16.43); another shape is its nearest (its first dash and space).
function dashAttributes(pattern: readonly number[], sink: DrawResourceSink): string | undefined {
	const dashes: number[] = []
	const spaces: number[] = []

	for (let index = 0; index + 1 < pattern.length; index += 2) {
		dashes.push(pattern[index] ?? 0)
		spaces.push(pattern[index + 1] ?? 0)
	}

	const space = spaces[0]
	const first = dashes[0]

	if (space === undefined || first === undefined) return undefined

	const runs: [number, number][] = []

	for (const dash of dashes) {
		const run = runs[runs.length - 1]

		if (run !== undefined && run[1] === dash) run[0]++
		else runs.push([1, dash])
	}

	let written = runs

	if (runs.length > 2 || spaces.some(value => value !== space)) {
		sink.approximated("dash pattern")
		written = [[1, first]]
	}

	const [one, two] = written
	const length = (widths: number): string => percent(widths * 100)

	return (
		` draw:style="rect" draw:dots1="${String(one?.[0] ?? 1)}" draw:dots1-length="${length(one?.[1] ?? first)}"` +
		(two === undefined ? "" : ` draw:dots2="${String(two[0])}" draw:dots2-length="${length(two[1])}"`) +
		` draw:distance="${length(space)}"`
	)
}

// Line ends (§20.1.8.38 a:headEnd, §20.1.8.57 a:tailEnd) as draw:marker shapes LibreOffice names alike (read/fills.ts
// reads them back by name), drawn in a 20-wide box whose height is the end's length to its width; written at the
// line width times PowerPoint's size steps (small 2, medium 3, large 5).
const END_SIZES: Readonly<Record<LineEnd["w"], number>> = { sm: 2, med: 3, lg: 5 }

function markerAttributes(end: LineEnd): { readonly attributes: string; readonly center: boolean } | undefined {
	const h = Math.round((20 * END_SIZES[end.len]) / END_SIZES[end.w])
	const view = ` svg:viewBox="0 0 20 ${String(h)}"`
	const at = (fraction: number): string => String(Math.round(h * fraction * 100) / 100)

	switch (end.type) {
		case "none":
			return undefined
		case "triangle":
			return { attributes: `${view} svg:d="M10 0L20 ${at(1)}H0Z"`, center: false }
		case "stealth":
			return { attributes: `${view} svg:d="M10 0L20 ${at(1)}L10 ${at(0.7)}L0 ${at(1)}Z"`, center: false }
		case "arrow":
			return {
				attributes: `${view} svg:d="M10 0L20 ${at(0.85)}L17 ${at(1)}L10 ${at(0.3)}L3 ${at(1)}L0 ${at(0.85)}Z"`,
				center: false
			}
		case "diamond":
			return { attributes: `${view} svg:d="M10 0L20 ${at(0.5)}L10 ${at(1)}L0 ${at(0.5)}Z"`, center: true }
		case "oval":
			return {
				attributes: `${view} svg:d="M10 0A10 ${at(0.5)} 0 1 1 10 ${at(1)}A10 ${at(0.5)} 0 1 1 10 0Z"`,
				center: true
			}
	}
}

const MARKER_NAMES: Readonly<Record<Exclude<LineEnd["type"], "none">, string>> = {
	triangle: "Arrow",
	stealth: "Stealth",
	arrow: "Line Arrow",
	diamond: "Diamond",
	oval: "Oval"
}

// A line's dash and ends ODF holds only through drawing resources, written on the style.
export function resourceLineChanges(changes: StyleChanges, line: LineProps, sink: DrawResourceSink): void {
	const family = "graphic"
	const pattern =
		line.custDash !== undefined
			? [...line.custDash].map(value => value / 100_000)
			: line.dash !== undefined && line.dash !== "solid"
				? DASHES[line.dash]
				: undefined

	if (pattern !== undefined) {
		const attributes = dashAttributes(pattern, sink)

		if (attributes !== undefined) {
			setProperty(changes, family, "draw:stroke", "dash")
			setProperty(changes, family, "draw:stroke-dash", sink.named("draw:stroke-dash", attributes))
		}
	}

	const width = Math.max(line.w ?? 9_525, 9_525)

	for (const [end, side] of [
		[line.head, "start"],
		[line.tail, "end"]
	] as const) {
		const marker = end === undefined ? undefined : markerAttributes(end)

		if (end === undefined || end.type === "none" || marker === undefined) continue

		const name = sink.named("draw:marker", ` draw:display-name="${MARKER_NAMES[end.type]}"${marker.attributes}`)

		setProperty(changes, family, `draw:marker-${side}`, name)
		setProperty(changes, family, `draw:marker-${side}-width`, cm(width * END_SIZES[end.w]))
		setProperty(changes, family, `draw:marker-${side}-center`, marker.center ? "true" : "false")
	}
}
