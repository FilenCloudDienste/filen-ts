import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { PresetClass, TimeNode, TimingTree } from "../core/anim/model"
import { presetToOdf, readOdpTiming } from "../core/anim/odf"
import { openOdp } from "../core/odp/read/document"
import { Fragment } from "../core/odp/read/context"
import { pageFragment } from "../core/odp/read/scan"
import { bytesSource } from "../core/opc/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { openPptx } from "../core/pptx/package"
import { readTiming } from "../core/pptx/read/timing"
import { partReader } from "../core/pptx/read/xml"
import { Namespaces, parseXml } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"
import { loCacheDir, readLoCache, readLoIndex, type LoAnimationNode } from "./oracles/presentation/lo"

// Timing read against LibreOffice 7.5's animation trees (XAnimationNode over UNO, the oracle cache's lo.json) for
// every animated pptx-family and odp deck of the corpus: per effect (an on-click, with-previous or after-previous
// node) its node type, preset id, class and subtype, begin and duration. Opt in with FILEN_OFFICE_LO_CACHE.

const cache = loCacheDir()
const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing
const OOXML = /\.(pptx|pptm|potx|potm|ppsx|ppsm)$/iu
// LibreOffice's effect node types; it gives the groups PowerPoint marks (clickPar, withGroup, afterGroup) the same ones.
const NODE_TYPES: Readonly<Record<string, string>> = {
	clickEffect: "1",
	withEffect: "2",
	afterEffect: "3",
	clickPar: "1",
	withGroup: "2",
	afterGroup: "3"
}
const CLASSES: Readonly<Record<string, string>> = { entr: "1", exit: "2", emph: "3", path: "4", verb: "5", mediacall: "6" }
const LO_CLASSES: Readonly<Record<string, PresetClass>> = {
	"1": "entr",
	"2": "exit",
	"3": "emph",
	"4": "path",
	"5": "verb",
	"6": "mediacall"
}

interface Effect {
	readonly nodeType: string
	readonly presetId: string | undefined
	readonly presetClass: string
	readonly subtype: string | undefined
	readonly begin: string
	readonly dur: string
}

function seconds(ms: number): string {
	return (Math.round(ms) / 1000).toFixed(3)
}

// LibreOffice 7.5 names a media-call effect only from a .ppt (sd's import writes "ppt_mediacall_1", which our
// conversion writes for every source); its pptx import has no media-call preset names (oox's preset_mapping), so it
// reports none for a pptx deck.
function ours(tree: TimingTree | undefined, pptx: boolean): Effect[] {
	const out: Effect[] = []
	const visit = (node: TimeNode): void => {
		const ctn = node.ctn
		const type = ctn.nodeType === undefined ? undefined : NODE_TYPES[ctn.nodeType]

		if (type !== undefined) {
			const preset = presetToOdf(ctn.presetClass, ctn.presetID, ctn.presetSubtype)
			// A plain delay, or one after a node's begin; a click, a shape event or "indefinite" is an event.
			const delay = ctn.stCondLst.find(
				c =>
					typeof c.delay === "number" &&
					(c.evt === undefined || ((c.evt === "onBegin" || c.evt === "begin") && c.tn !== undefined))
			)?.delay

			out.push({
				nodeType: type,
				presetId: pptx && ctn.presetClass === "mediacall" ? undefined : (preset.id ?? ctn.presetName),
				presetClass: ctn.presetClass === undefined ? "0" : (CLASSES[ctn.presetClass] ?? "0"),
				subtype: preset.subtype ?? ctn.presetSubtypeName,
				// LibreOffice holds a begin that waits (indefinite, an event) as an event trigger.
				begin: typeof delay === "number" ? seconds(delay) : "event",
				dur: ctn.dur === undefined ? "none" : ctn.dur === "indefinite" ? "indefinite" : seconds(ctn.dur)
			})

			return
		}

		for (const child of ctn.children) visit(child)
	}

	if (tree !== undefined) visit(tree.root)

	return out
}

function ourCount(tree: TimingTree | undefined): number {
	const count = (node: TimeNode): number => node.ctn.children.reduce((sum, child) => sum + count(child), 1)

	return tree === undefined ? 0 : count(tree.root)
}

function loCount(node: LoAnimationNode | undefined): number {
	return node === undefined ? 0 : (node.children ?? []).reduce((sum, child) => sum + loCount(child), 1)
}

function loTime(value: string | null): string {
	if (value === null || value === "None") return "none"
	if (value.includes("INDEFINITE")) return "indefinite"

	const number = Number(value)

	return Number.isFinite(number) ? seconds(number * 1000) : "event"
}

function theirs(node: LoAnimationNode | undefined): Effect[] {
	const out: Effect[] = []
	const visit = (n: LoAnimationNode): void => {
		const type = n["node-type"]

		if (type === "1" || type === "2" || type === "3") {
			const id = n["preset-id"]
			const presetClass = n["preset-class"] ?? "0"
			const subtype = n["preset-sub-type"]
			// A file that wrote the ECMA number as its preset id: the same preset under LibreOffice's name.
			const numeric =
				id !== undefined && /^\d+$/u.test(id)
					? presetToOdf(
							LO_CLASSES[presetClass],
							Number(id),
							subtype !== undefined && /^\d+$/u.test(subtype) ? Number(subtype) : undefined
						)
					: undefined

			out.push({
				nodeType: type,
				presetId: numeric !== undefined ? numeric.id : id === "" ? undefined : id,
				presetClass,
				subtype: numeric !== undefined ? numeric.subtype : subtype === "" || subtype === "0" ? undefined : subtype,
				begin: loTime(n.begin),
				dur: loTime(n.dur)
			})

			return
		}

		for (const child of n.children ?? []) visit(child)
	}

	if (node !== undefined) visit(node)

	return out
}

async function pptxTimings(bytes: Uint8Array): Promise<(TimingTree | undefined)[]> {
	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") return []

	const files = unzipSync(bytes)

	return open.deck.slides.map(ref => {
		const part = open.parts.partOf(ref)
		const data = part === undefined ? undefined : files[part.replace(/^\//u, "")]

		if (data === undefined) return undefined

		const document = parseXml(data)

		return readTiming({ reader: partReader(document), part: part ?? "", epoch: 0, budgets: BUDGETS }, document.documentElement())
	})
}

async function odpTimings(bytes: Uint8Array): Promise<(TimingTree | undefined)[]> {
	const open = await openOdp(bytesSource(bytes))

	if (open.kind !== "opened") return []

	const out: (TimingTree | undefined)[] = []

	for (const [index, ref] of open.deck.slides.entries()) {
		const span = open.parts.content.pages[index]

		if (span === undefined) {
			out.push(undefined)

			continue
		}

		const slide = await open.parts.slide(ref)
		const document = pageFragment(open.parts.content, span)
		const fragment = new Fragment(
			document,
			new Namespaces(document, { lenient: true }),
			"content.xml",
			span.start,
			"content",
			open.parts.epoch
		)

		out.push(readOdpTiming(fragment, document.firstChildElement(document.documentElement()), slide.shapes, BUDGETS))
	}

	return out
}

describe("timing against LibreOffice's animation trees", () => {
	it.skipIf(cache === undefined)(
		"reads ≥ 98% of the corpus's effects as LibreOffice does",
		async () => {
			const index = readLoIndex(cache ?? "").filter(
				entry => entry.status === "cached" && (OOXML.test(entry.path) || entry.path.endsWith(".odp"))
			)
			let effects = 0
			let equal = 0
			let decks = 0
			let slides = 0
			let sameCount = 0
			const misses: string[] = []

			for (const entry of index) {
				const lo = readLoCache(cache ?? "", entry.sha256)
				const file = join(CORPUS_DIR, entry.path)

				if (lo === undefined || !existsSync(file) || !(lo.deck.slides ?? []).some(slide => slide.animation !== undefined)) continue

				const loEffects = (lo.deck.slides ?? []).map(slide => theirs(slide.animation))

				if (loEffects.every(list => list.length === 0)) continue

				const bytes = new Uint8Array(readFileSync(file))
				const timings = entry.path.endsWith(".odp") ? await odpTimings(bytes) : await pptxTimings(bytes)

				decks++
				loEffects.forEach((expected, slide) => {
					const actual = ours(timings[slide], !entry.path.endsWith(".odp"))
					const loNodes = loCount(lo.deck.slides?.[slide]?.animation)

					if (loNodes > 0) {
						slides++

						if (ourCount(timings[slide]) === loNodes) sameCount++
						else
							misses.push(
								`${entry.path} #${String(slide + 1)} nodes lo ${String(loNodes)} ours ${String(ourCount(timings[slide]))}`
							)
					}

					for (let k = 0; k < Math.max(expected.length, actual.length); k++) {
						effects++

						if (JSON.stringify(expected[k]) === JSON.stringify(actual[k])) equal++
						else
							misses.push(
								`${entry.path} #${String(slide + 1)}.${String(k)} lo ${JSON.stringify(expected[k])} ours ${JSON.stringify(actual[k])}`
							)
					}
				})
			}

			expect(decks).toBeGreaterThan(0)
			if (process.env["FILEN_OFFICE_ANIM_MISSES"] !== undefined)
				writeFileSync(
					process.env["FILEN_OFFICE_ANIM_MISSES"],
					`${JSON.stringify({ ratio: equal / effects, effects, decks, slides, sameCount })}\n${misses.join("\n")}`
				)

			expect({ ratio: equal / effects, effects, decks, misses: equal / effects >= 0.98 ? [] : misses.slice(0, 20) }).toMatchObject({
				misses: []
			})
			expect(equal / effects).toBeGreaterThanOrEqual(0.98)
			expect(sameCount / slides).toBeGreaterThanOrEqual(0.98)
		},
		600_000
	)
})
