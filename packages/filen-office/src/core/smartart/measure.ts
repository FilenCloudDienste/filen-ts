import { DEFAULT_BODY_PR } from "../presentation/inherit"
import type { ParaProps, Run, RunProps, Spacing } from "../presentation/model"
import { fontRequests, layoutBody, type TextEnvironment } from "../presentation/text/body"
import type { ResolvedBody, TextFonts } from "../presentation/text/resolve"
import type { FontRequest } from "../fonts/index"
import { LINE_FLOATS, LineFloat, type TextLayout } from "../text/index"
import type { DataPoint, RichRun } from "./data"

// Text measurement for the tx algorithm. The layout engine sizes text only to choose font sizes and to know when a
// node overflows, so it measures through a narrow interface; the presentation worker backs it with the slide text
// adapter (core/presentation/text layoutBody), so the sizes the diagram settles on are the ones the slide draws.

// The height in EMU of `text` (paragraphs joined by "\n") set at `fontPt` and wrapped at `width` EMU, and its widest
// line or unbreakable word, whichever is wider (a word wider than the box does not fit even when the line breaker
// splits it).
export interface TextMeasurer {
	measure(text: string, fontPt: number, width: number): { readonly width: number; readonly height: number }
	// The same for a node's text as the drawing sets it (measureText): its runs' weight, slant and face, the
	// paragraph spacing, and the children's paragraphs as bullets at `childPt`. Measurers without it are asked
	// measure() with the plain text.
	measureText?(text: MeasureText, fontPt: number, childPt: number, width: number): { readonly width: number; readonly height: number }
}

// One paragraph of a node's text: level 0 for the node's own points, 1 and deeper for the points under them.
export interface MeasureParagraph {
	readonly level: number
	readonly runs: readonly RichRun[]
	readonly lnSpc?: Spacing | undefined
	readonly spcBef?: Spacing | undefined
	readonly spcAft?: Spacing | undefined
	readonly bullet: boolean
}

export interface MeasureText {
	// Identifies the text and its properties for the measurer's answer cache.
	readonly key: string
	readonly paragraphs: readonly MeasureParagraph[]
}

// The paragraph spacing a diagram's text takes where its own pPr sets none, as PowerPoint writes it on every
// drawing it caches (MS-ODRAWXML §1.3.4 dsp:txBody): 90% lines, nothing before, 35% of the size after a node's own
// paragraph and 15% after a child's. A child's bullet hangs by three quarters of its size.
const SMARTART_LINE: Spacing = { pct: 90000 }
const NO_SPACE: Spacing = { pct: 0 }
const AFTER_NODE: Spacing = { pct: 35000 }
const AFTER_CHILD: Spacing = { pct: 15000 }
const BULLET_INDENT = 0.75
const EMU_PER_PT = 12700

// The paragraphs of the text points `points` present, levelled by depth under the presenting node's own point
// (`ownDepth`: a node presenting its children shows them at level 1, as the drawing does), else under the first.
export function measureText(points: readonly DataPoint[], bullets: boolean, ownDepth?: number): MeasureText {
	const paragraphs: MeasureParagraph[] = []
	const first = points[0]
	const base = first === undefined ? 0 : Math.min(first.depth, ownDepth ?? first.depth)

	points.forEach((point, index) => {
		const level = first === undefined ? 0 : Math.max(index === 0 ? 0 : 1, Math.min(8, point.depth - base))
		const rich = point.rich
		// Rich paragraphs that no longer spell the text (edited since) are not used.
		const usable =
			rich !== undefined &&
			rich.length === point.paragraphs.length &&
			rich.every((p, i) => p.runs.map(run => run.text).join("") === point.paragraphs[i])

		point.paragraphs.forEach((text, i) => {
			const source = usable ? rich[i] : undefined
			const runs: readonly RichRun[] = source?.runs ?? (text === "" ? [] : [{ text }])

			paragraphs.push({
				level,
				runs,
				lnSpc: source?.lnSpc,
				spcBef: source?.spcBef,
				spcAft: source?.spcAft,
				bullet: bullets && level > 0
			})
		})
	})

	return { key: measureKey(paragraphs), paragraphs }
}

function spacingKey(spacing: Spacing | undefined): string {
	return spacing === undefined ? "" : "pct" in spacing ? `%${spacing.pct}` : `p${spacing.pts}`
}

// A key for paragraphs that changes with every property measurement reads.
function measureKey(paragraphs: readonly MeasureParagraph[]): string {
	let key = ""

	for (const p of paragraphs) {
		key += `\u0001${p.level}${p.bullet ? "b" : ""}${spacingKey(p.lnSpc)};${spacingKey(p.spcBef)};${spacingKey(p.spcAft)}`

		for (const run of p.runs) key += `\u0002${run.b === true ? "B" : ""}${run.i === true ? "I" : ""}${run.latin ?? ""}\u0003${run.text}`
	}

	return key
}

const EMU_PX = 9525
// Widest words are measured once per text at this size and scaled: advances are linear in the size.
const REFERENCE_PT = 100
const MAX_WORD_CACHE = 4096
const MAX_ANSWERS = 16384

export interface SmartArtTextOptions {
	// The run properties diagram text takes (the style's typeface, bold): the minor theme font when absent.
	readonly rPr?: RunProps
}

function body(text: string, fontPt: number, wrap: boolean, fonts: TextFonts, rPr: RunProps): ResolvedBody {
	const run: RunProps = {
		latin: { typeface: "+mn-lt" },
		ea: { typeface: "+mn-ea" },
		cs: { typeface: "+mn-cs" },
		...rPr,
		sz: Math.round(fontPt * 100)
	}
	const paragraphs = text.split("\n").map(line => ({
		level: 0,
		pPr: { algn: "ctr" as const },
		runs: line === "" ? [] : [{ kind: "r" as const, text: line, rPr: run }],
		endRPr: run,
		defRPr: run
	}))

	return {
		bodyPr: { ...DEFAULT_BODY_PR, insets: { left: 0, top: 0, right: 0, bottom: 0 }, wrap, autofit: "none" },
		paragraphs,
		fonts
	}
}

function richRunProps(run: RichRun, fontPt: number, base: RunProps): RunProps {
	return {
		latin: { typeface: run.latin ?? "+mn-lt" },
		ea: { typeface: "+mn-ea" },
		cs: { typeface: "+mn-cs" },
		...base,
		...(run.b === undefined ? {} : { b: run.b }),
		...(run.i === undefined ? {} : { i: run.i }),
		sz: Math.round(fontPt * 100)
	}
}

function richParagraph(
	paragraph: MeasureParagraph,
	runs: readonly RichRun[],
	fontPt: number,
	rPr: RunProps
): ResolvedBody["paragraphs"][number] {
	const level = paragraph.level
	const marL = paragraph.bullet ? level * BULLET_INDENT * fontPt * EMU_PER_PT : 0
	const pPr: ParaProps = {
		algn: level === 0 ? "ctr" : "l",
		lnSpc: paragraph.lnSpc ?? SMARTART_LINE,
		spcBef: paragraph.spcBef ?? NO_SPACE,
		spcAft: paragraph.spcAft ?? (level === 0 ? AFTER_NODE : AFTER_CHILD),
		...(paragraph.bullet
			? { marL, indent: -BULLET_INDENT * fontPt * EMU_PER_PT, bullet: { kind: "char" as const, char: "\u2022" } }
			: {})
	}
	const end = richRunProps(runs[runs.length - 1] ?? { text: "" }, fontPt, rPr)
	const out: Run[] = []

	for (const run of runs) {
		if (run.text === "\n") out.push({ kind: "br", rPr: richRunProps(run, fontPt, rPr) })
		else if (run.text !== "") out.push({ kind: "r", text: run.text, rPr: richRunProps(run, fontPt, rPr) })
	}

	return { level, pPr, runs: out, endRPr: end, defRPr: end }
}

function richBody(text: MeasureText, fontPt: number, childPt: number, wrap: boolean, fonts: TextFonts, rPr: RunProps): ResolvedBody {
	return {
		bodyPr: { ...DEFAULT_BODY_PR, insets: { left: 0, top: 0, right: 0, bottom: 0 }, wrap, autofit: "none" },
		paragraphs: text.paragraphs.map(p => richParagraph(p, p.runs, p.level === 0 ? fontPt : childPt, rPr)),
		fonts
	}
}

// Each word of `text` as a paragraph of its own (its runs' pieces kept), unwrapped, for the widest word per level.
function wordsBody(text: MeasureText, level0: boolean, fontPt: number, fonts: TextFonts, rPr: RunProps): ResolvedBody {
	const paragraphs: ResolvedBody["paragraphs"][number][] = []

	for (const paragraph of text.paragraphs) {
		if ((paragraph.level === 0) !== level0) continue

		let word: RichRun[] = []
		const flush = (): void => {
			if (word.length > 0) paragraphs.push(richParagraph({ ...paragraph, bullet: false, level: 0 }, word, fontPt, rPr))

			word = []
		}

		for (const run of paragraph.runs) {
			const pieces = run.text.split(/(\s+)/u)

			for (const piece of pieces) {
				if (piece === "") continue

				if (/^\s+$/u.test(piece)) flush()
				else word.push({ ...run, text: piece })
			}
		}

		flush()
	}

	return {
		bodyPr: { ...DEFAULT_BODY_PR, insets: { left: 0, top: 0, right: 0, bottom: 0 }, wrap: false, autofit: "none" },
		paragraphs,
		fonts
	}
}

// The fonts a diagram's texts draw with, to prepare before layout (TextEnvironment.fonts resolves synchronously).
// Data points are measured with their runs' weight, slant and face (measureText), so they ask for those faces.
export function smartArtFontRequests(
	texts: readonly (string | DataPoint)[],
	fonts: TextFonts,
	options: SmartArtTextOptions = {}
): FontRequest[] {
	const out = new Map<string, FontRequest>()
	const rPr = options.rPr ?? {}

	for (const text of texts) {
		const laid =
			typeof text === "string" ? body(text, 18, true, fonts, rPr) : richBody(measureText([text], true), 18, 18, true, fonts, rPr)

		for (const request of fontRequests(laid)) out.set(JSON.stringify(request), request)
	}

	return [...out.values()]
}

function widestLine(layout: TextLayout, start: number): number {
	let widest = start

	for (let line = 0; line < layout.lineCount; line++)
		widest = Math.max(widest, layout.lineFloats[line * LINE_FLOATS + LineFloat.WIDTH] ?? 0)

	return widest
}

// A measurer over the slide text adapter.
export function textAdapterMeasurer(env: TextEnvironment, fonts: TextFonts, options: SmartArtTextOptions = {}): TextMeasurer {
	const rPr = options.rPr ?? {}
	const words = new Map<string, number>()

	const widestWord = (text: string): number => {
		let width = words.get(text)

		if (width === undefined) {
			// One word per paragraph, unwrapped: the widest line is the widest word.
			const list = text.split(/\s+/u).filter(word => word !== "")
			const laid = layoutBody(body(list.join("\n"), REFERENCE_PT, false, fonts, rPr), { width: 1e7, height: 1e7 }, env).layout

			width = widestLine(laid, 0)

			if (words.size >= MAX_WORD_CACHE) words.clear()

			words.set(text, width)
		}

		return width
	}

	// Rule relaxation and font fitting ask the same questions again as they bisect: the answers are kept.
	const answers = new Map<string, { readonly width: number; readonly height: number }>()

	// Widest words per text and level at the reference size.
	const richWords = new Map<string, readonly [number, number]>()
	const widestRich = (text: MeasureText): readonly [number, number] => {
		let widths = richWords.get(text.key)

		if (widths === undefined) {
			const own = layoutBody(wordsBody(text, true, REFERENCE_PT, fonts, rPr), { width: 1e7, height: 1e7 }, env).layout
			const children = text.paragraphs.some(p => p.level > 0)
				? widestLine(layoutBody(wordsBody(text, false, REFERENCE_PT, fonts, rPr), { width: 1e7, height: 1e7 }, env).layout, 0)
				: 0

			widths = [widestLine(own, 0), children]

			if (richWords.size >= MAX_WORD_CACHE) richWords.clear()

			richWords.set(text.key, widths)
		}

		return widths
	}

	return {
		measureText(text, fontPt, childPt, width) {
			const key = `${fontPt}\u0000${childPt}\u0000${Math.round(width)}\u0000${text.key}`
			let answer = answers.get(key)

			if (answer === undefined) {
				const box = { width: Math.max(0, width / EMU_PX), height: 1e7 }
				const result = layoutBody(richBody(text, fontPt, childPt, true, fonts, rPr), box, env)
				const [own, children] = widestRich(text)
				// A child's word starts after its bullet's hanging indent.
				const childIndent = text.paragraphs.reduce(
					(max, p) => (p.bullet ? Math.max(max, (p.level * BULLET_INDENT * childPt * EMU_PER_PT) / EMU_PX) : max),
					0
				)
				const words = Math.max((own * fontPt) / REFERENCE_PT, children > 0 ? (children * childPt) / REFERENCE_PT + childIndent : 0)
				const widest = widestLine(result.layout, words)

				answer = { width: widest * EMU_PX, height: result.height * EMU_PX }

				if (answers.size >= MAX_ANSWERS) answers.clear()

				answers.set(key, answer)
			}

			return answer
		},
		measure(text, fontPt, width) {
			const key = `${fontPt}\u0000${Math.round(width)}\u0000${text}`
			let answer = answers.get(key)

			if (answer === undefined) {
				const box = { width: Math.max(0, width / EMU_PX), height: 1e7 }
				const result = layoutBody(body(text, fontPt, true, fonts, rPr), box, env)
				const widest = widestLine(result.layout, (widestWord(text) * fontPt) / REFERENCE_PT)

				answer = { width: widest * EMU_PX, height: result.height * EMU_PX }

				if (answers.size >= MAX_ANSWERS) answers.clear()

				answers.set(key, answer)
			}

			return answer
		}
	}
}
