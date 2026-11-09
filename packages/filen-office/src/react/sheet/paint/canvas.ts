// The part of a 2D canvas context the grid draws with, in types of its own so the painters type-check (and run)
// without a DOM: a browser hands in its canvas context, a test a recorder.
export interface GridCanvas {
	// A CSS colour, or a pattern from createPattern.
	fillStyle: string | object
	strokeStyle: string | object
	lineWidth: number
	// Where the dashes start along a path; a surface without it (print) draws them from the start.
	lineDashOffset?: number
	font: string
	textAlign: "left" | "right" | "center" | "start" | "end"
	textBaseline: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom"
	beginPath(): void
	clip(): void
	clearRect(x: number, y: number, width: number, height: number): void
	createPattern(image: never, repetition: "repeat"): object | null
	fillRect(x: number, y: number, width: number, height: number): void
	fillText(text: string, x: number, y: number): void
	lineTo(x: number, y: number): void
	measureText(text: string): { readonly width: number }
	moveTo(x: number, y: number): void
	rect(x: number, y: number, width: number, height: number): void
	restore(): void
	rotate(angle: number): void
	save(): void
	setLineDash(segments: number[]): void
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
	stroke(): void
	translate(x: number, y: number): void
}

// 0xRRGGBB as CSS.
export function rgb(color: number): string {
	return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`
}
