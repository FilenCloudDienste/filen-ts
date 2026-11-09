import type { GridCanvas } from "../react/sheet/paint/canvas"

// A 2D context that records what the grid draws, for tests without a canvas (happy-dom has none). Text measures
// as 0.55 of its font's pixel size per character.

export interface DrawCall {
	readonly op: string
	readonly args: readonly unknown[]
	readonly fill: unknown
	readonly stroke: unknown
	readonly font: string
	readonly lineWidth: number
	readonly dash: readonly number[]
	readonly dashOffset: number
}

export function fontPx(font: string): number {
	return Number(/([\d.]+)px/u.exec(font)?.[1] ?? "10")
}

export class RecordingCanvas implements GridCanvas {
	calls: DrawCall[] = []
	fillStyle: string | object = "#000"
	strokeStyle: string | object = "#000"
	lineWidth = 1
	lineDashOffset = 0
	font = "10px sans-serif"
	textAlign: GridCanvas["textAlign"] = "start"
	textBaseline: GridCanvas["textBaseline"] = "alphabetic"
	measured = 0
	private dash: number[] = []

	private record(op: string, args: unknown[]): void {
		this.calls.push({
			op,
			args,
			fill: this.fillStyle,
			stroke: this.strokeStyle,
			font: this.font,
			lineWidth: this.lineWidth,
			dash: this.dash,
			dashOffset: this.lineDashOffset
		})
	}

	reset(): void {
		this.calls = []
	}

	texts(): string[] {
		return this.calls.filter(call => call.op === "fillText").map(call => call.args[0] as string)
	}

	beginPath(): void {}
	closePath(): void {}
	clip(): void {}
	fill(): void {}
	save(): void {}
	restore(): void {}
	setTransform(): void {}

	clearRect(...args: number[]): void {
		this.record("clearRect", args)
	}

	createPattern(): object | null {
		return null
	}

	fillRect(...args: number[]): void {
		this.record("fillRect", args)
	}

	fillText(text: string, x: number, y: number): void {
		this.record("fillText", [text, x, y])
	}

	lineTo(...args: number[]): void {
		this.record("lineTo", args)
	}

	moveTo(...args: number[]): void {
		this.record("moveTo", args)
	}

	measureText(text: string): { readonly width: number } {
		this.measured++

		return { width: [...text].length * fontPx(this.font) * 0.55 }
	}

	rect(...args: number[]): void {
		this.record("rect", args)
	}

	rotate(angle: number): void {
		this.record("rotate", [angle])
	}

	translate(...args: number[]): void {
		this.record("translate", args)
	}

	setLineDash(dash: number[]): void {
		this.dash = [...dash]
	}

	stroke(): void {
		this.record("stroke", [])
	}
}
