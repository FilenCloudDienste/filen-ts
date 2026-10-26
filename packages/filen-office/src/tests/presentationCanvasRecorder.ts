import type { Canvas2DLike, CanvasGradientLike, CanvasPatternLike, CanvasSurface, ImageDataLike } from "../core/drawingml/canvas"

// A 2D context that records what the canvas painters draw, with the state each call ran in (transform, styles,
// alpha, shadow, dash), for tests without a real canvas. Text measures FIXTURE_ADVANCE px per character.

export const RECORDED_ADVANCE = 9

export interface RecordedImage {
	readonly width: number
	readonly height: number
	readonly name?: string
	readonly surface?: RecordingCanvas
	close?(): void
}

export class RecordedGradient implements CanvasGradientLike {
	readonly stops: [number, string][] = []
	readonly kind: "linear" | "radial"
	readonly args: readonly number[]

	constructor(kind: "linear" | "radial", args: readonly number[]) {
		this.kind = kind
		this.args = args
	}

	addColorStop(offset: number, color: string): void {
		this.stops.push([offset, color])
	}
}

export class RecordedPattern implements CanvasPatternLike {
	readonly image: RecordedImage
	transform: { a: number; b: number; c: number; d: number; e: number; f: number } | undefined

	constructor(image: RecordedImage) {
		this.image = image
	}

	setTransform(transform: { a: number; b: number; c: number; d: number; e: number; f: number }): void {
		this.transform = transform
	}
}

export interface Recorded {
	readonly op: string
	readonly args: readonly unknown[]
	readonly transform: readonly number[]
	readonly fill: unknown
	readonly stroke: unknown
	readonly alpha: number
	readonly font: string
	readonly lineWidth: number
	readonly dash: readonly number[]
	readonly shadow: readonly [string, number, number, number]
	readonly composite: string
	readonly direction: string
	readonly align: string
}

interface State {
	transform: number[]
	fill: unknown
	stroke: unknown
	alpha: number
	font: string
	lineWidth: number
	lineCap: string
	lineJoin: string
	miterLimit: number
	dash: number[]
	shadow: [string, number, number, number]
	composite: string
	align: string
	baseline: string
	direction: string
	letterSpacing: string
	wordSpacing: string
	caps: string
	clips: number
}

function initial(): State {
	return {
		transform: [1, 0, 0, 1, 0, 0],
		fill: "#000000",
		stroke: "#000000",
		alpha: 1,
		font: "10px sans-serif",
		lineWidth: 1,
		lineCap: "butt",
		lineJoin: "miter",
		miterLimit: 10,
		dash: [],
		shadow: ["rgba(0, 0, 0, 0)", 0, 0, 0],
		composite: "source-over",
		align: "start",
		baseline: "alphabetic",
		direction: "inherit",
		letterSpacing: "0px",
		wordSpacing: "0px",
		caps: "normal",
		clips: 0
	}
}

export class RecordingCanvas implements Canvas2DLike<RecordedImage>, RecordedImage {
	readonly calls: Recorded[] = []
	readonly width: number
	readonly height: number
	readonly name: string
	// Pixels of putImageData/getImageData (a scratch surface's).
	readonly pixels: Uint8ClampedArray
	private state: State = initial()
	private readonly stack: State[] = []
	// Whether the context offers letterSpacing/wordSpacing (Chromium and Firefox do).
	private readonly spacing: boolean
	imageSmoothingEnabled = true

	constructor(width = 0, height = 0, name = "canvas", spacing = true) {
		this.width = width
		this.height = height
		this.name = name
		this.spacing = spacing
		this.pixels = new Uint8ClampedArray(Math.max(0, width * height * 4))
	}

	get surface(): RecordingCanvas {
		return this
	}

	private record(op: string, args: unknown[]): void {
		const s = this.state

		this.calls.push({
			op,
			args,
			transform: [...s.transform],
			fill: s.fill,
			stroke: s.stroke,
			alpha: s.alpha,
			font: s.font,
			lineWidth: s.lineWidth,
			dash: [...s.dash],
			shadow: [...s.shadow],
			composite: s.composite,
			direction: s.direction,
			align: s.align
		})
	}

	ops(op: string): Recorded[] {
		return this.calls.filter(call => call.op === op)
	}

	get globalAlpha(): number {
		return this.state.alpha
	}
	set globalAlpha(value: number) {
		this.state.alpha = value
	}
	get globalCompositeOperation(): string {
		return this.state.composite
	}
	set globalCompositeOperation(value: string) {
		this.state.composite = value
	}
	get fillStyle(): unknown {
		return this.state.fill
	}
	set fillStyle(value: unknown) {
		this.state.fill = value
	}
	get strokeStyle(): unknown {
		return this.state.stroke
	}
	set strokeStyle(value: unknown) {
		this.state.stroke = value
	}
	get lineWidth(): number {
		return this.state.lineWidth
	}
	set lineWidth(value: number) {
		this.state.lineWidth = value
	}
	get lineCap(): string {
		return this.state.lineCap
	}
	set lineCap(value: string) {
		this.state.lineCap = value
	}
	get lineJoin(): string {
		return this.state.lineJoin
	}
	set lineJoin(value: string) {
		this.state.lineJoin = value
	}
	get miterLimit(): number {
		return this.state.miterLimit
	}
	set miterLimit(value: number) {
		this.state.miterLimit = value
	}
	get font(): string {
		return this.state.font
	}
	set font(value: string) {
		this.state.font = value
	}
	get textAlign(): string {
		return this.state.align
	}
	set textAlign(value: string) {
		this.state.align = value
	}
	get textBaseline(): string {
		return this.state.baseline
	}
	set textBaseline(value: string) {
		this.state.baseline = value
	}
	get direction(): string {
		return this.state.direction
	}
	set direction(value: string) {
		this.state.direction = value
	}
	get letterSpacing(): string | undefined {
		return this.spacing ? this.state.letterSpacing : undefined
	}
	set letterSpacing(value: string | undefined) {
		if (value !== undefined) this.state.letterSpacing = value
	}
	get wordSpacing(): string | undefined {
		return this.spacing ? this.state.wordSpacing : undefined
	}
	set wordSpacing(value: string | undefined) {
		if (value !== undefined) this.state.wordSpacing = value
	}
	get fontVariantCaps(): string {
		return this.state.caps
	}
	set fontVariantCaps(value: string) {
		this.state.caps = value
	}
	get shadowColor(): string {
		return this.state.shadow[0]
	}
	set shadowColor(value: string) {
		this.state.shadow[0] = value
	}
	get shadowBlur(): number {
		return this.state.shadow[1]
	}
	set shadowBlur(value: number) {
		this.state.shadow[1] = value
	}
	get shadowOffsetX(): number {
		return this.state.shadow[2]
	}
	set shadowOffsetX(value: number) {
		this.state.shadow[2] = value
	}
	get shadowOffsetY(): number {
		return this.state.shadow[3]
	}
	set shadowOffsetY(value: number) {
		this.state.shadow[3] = value
	}

	get depth(): number {
		return this.stack.length
	}

	get clipCount(): number {
		return this.state.clips
	}

	save(): void {
		const s = this.state

		this.stack.push({ ...s, transform: [...s.transform], dash: [...s.dash], shadow: [...s.shadow] })
	}

	restore(): void {
		const top = this.stack.pop()

		if (top !== undefined) this.state = top
	}

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.state.transform = [a, b, c, d, e, f]
	}

	beginPath(): void {
		this.record("beginPath", [])
	}
	moveTo(x: number, y: number): void {
		this.record("moveTo", [x, y])
	}
	lineTo(x: number, y: number): void {
		this.record("lineTo", [x, y])
	}
	bezierCurveTo(...args: number[]): void {
		this.record("bezierCurveTo", args)
	}
	quadraticCurveTo(...args: number[]): void {
		this.record("quadraticCurveTo", args)
	}
	closePath(): void {
		this.record("closePath", [])
	}
	rect(...args: number[]): void {
		this.record("rect", args)
	}
	fill(rule?: string): void {
		this.record("fill", [rule ?? "nonzero"])
	}
	stroke(): void {
		this.record("stroke", [])
	}
	clip(rule?: string): void {
		this.state.clips++
		this.record("clip", [rule ?? "nonzero"])
	}
	fillRect(...args: number[]): void {
		this.record("fillRect", args)
	}
	clearRect(...args: number[]): void {
		this.record("clearRect", args)
	}
	setLineDash(segments: number[]): void {
		this.state.dash = [...segments]
	}
	createLinearGradient(...args: number[]): CanvasGradientLike {
		return new RecordedGradient("linear", args)
	}
	createRadialGradient(...args: number[]): CanvasGradientLike {
		return new RecordedGradient("radial", args)
	}
	createPattern(image: RecordedImage): CanvasPatternLike | null {
		return new RecordedPattern(image)
	}
	drawImage(image: RecordedImage, ...args: number[]): void {
		this.record("drawImage", [image.name ?? "image", ...args])
	}
	fillText(text: string, x: number, y: number): void {
		this.record("fillText", [text, x, y])
	}
	strokeText(text: string, x: number, y: number): void {
		this.record("strokeText", [text, x, y])
	}
	measureText(text: string): { readonly width: number } {
		return { width: [...text].length * RECORDED_ADVANCE }
	}
	createImageData(width: number, height: number): ImageDataLike {
		return { width, height, data: new Uint8ClampedArray(width * height * 4) }
	}
	getImageData(x: number, y: number, width: number, height: number): ImageDataLike {
		const data = new Uint8ClampedArray(width * height * 4)

		for (let row = 0; row < height; row++) {
			const from = ((y + row) * this.width + x) * 4

			data.set(this.pixels.subarray(from, from + width * 4), row * width * 4)
		}

		this.record("getImageData", [x, y, width, height])

		return { width, height, data }
	}
	putImageData(image: ImageDataLike, x: number, y: number): void {
		for (let row = 0; row < image.height; row++) {
			const to = ((y + row) * this.width + x) * 4

			this.pixels.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), to)
		}

		this.record("putImageData", [x, y, image.width, image.height])
	}
}

// Scratch surfaces as the painter asks for them, kept for inspection.
export function recordingSurfaces(): {
	readonly made: RecordingCanvas[]
	surface(width: number, height: number): CanvasSurface<RecordedImage>
} {
	const made: RecordingCanvas[] = []

	return {
		made,
		surface(width, height) {
			const canvas = new RecordingCanvas(width, height, `surface${String(made.length)}`)

			made.push(canvas)

			return { canvas, context: canvas }
		}
	}
}
