import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { PresetClass, TimeNode, TimingTree } from "../core/anim/model"
import { presetToOdf } from "../core/anim/odf"
import { bytesSource } from "../core/opc/index"
import { openPptFile, readDocument } from "../core/ppt/document"
import { readSlides } from "../core/ppt/slides"
import { pptToPptx } from "../core/ppt/toPptx"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { openPptxPackage } from "../core/pptx/package"
import { readTiming } from "../core/pptx/read/timing"
import { partReader } from "../core/pptx/read/xml"
import { parseXml } from "../core/xml/index"
import { CORPUS_DIR } from "./corpusDir"
import { loCacheDir, readLoCache, readLoIndex, type LoAnimationNode } from "./oracles/presentation/lo"

// The animations of the corpus's PowerPoint 97–2003 decks, converted and read back as PresentationML timing, against
// LibreOffice 7.5's animation trees of the same files (the oracle cache's lo.json): per effect its node type, preset
// id, class and subtype, begin and duration, and per slide the node count. Decks with a PowerPoint 2002 time tree and
// decks with Office 97 builds only are measured apart. Opt in with FILEN_OFFICE_LO_CACHE.

const cache = loCacheDir()
const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing
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

function ours(tree: TimingTree | undefined): Effect[] {
	const out: Effect[] = []
	const visit = (node: TimeNode): void => {
		const ctn = node.ctn
		const type = ctn.nodeType === undefined ? undefined : NODE_TYPES[ctn.nodeType]

		if (type !== undefined) {
			const preset = presetToOdf(ctn.presetClass, ctn.presetID, ctn.presetSubtype)
			const delay = ctn.stCondLst.find(
				c =>
					typeof c.delay === "number" &&
					(c.evt === undefined || ((c.evt === "onBegin" || c.evt === "begin") && c.tn !== undefined))
			)?.delay

			out.push({
				nodeType: type,
				// LibreOffice names a preset of a class it has no names for after the class and number.
				presetId:
					preset.id ??
					ctn.presetName ??
					(ctn.presetID === undefined || ctn.presetClass === undefined
						? undefined
						: `ppt_${ctn.presetClass}_${String(ctn.presetID)}`),
				presetClass: ctn.presetClass === undefined ? "0" : (CLASSES[ctn.presetClass] ?? "0"),
				subtype: preset.subtype ?? ctn.presetSubtypeName,
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

// Time nodes of the slide's tree as written: p:cTn elements outside the build templates (sub-effects included, which
// LibreOffice holds as nodes of their own).
function ourCount(xml: string | undefined): number {
	const tree = xml?.split("<p:bldLst")[0] ?? ""

	return tree.split("<p:cTn ").length - 1
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

// Per slide: the converted deck's timing, and whether the slide carried a PowerPoint 2002 tree.
async function pptTimings(bytes: Uint8Array): Promise<{ readonly tree: TimingTree | undefined; readonly xml: string }[] | undefined> {
	const converted = await pptToPptx(bytesSource(bytes))

	if (converted.kind !== "converted") return undefined

	const open = await openPptxPackage(converted.pptx)

	if (open.kind !== "opened") return undefined

	const out: { readonly tree: TimingTree | undefined; readonly xml: string }[] = []

	for (const ref of open.deck.slides) {
		const part = open.parts.partOf(ref)

		if (part === undefined) {
			out.push({ tree: undefined, xml: "" })

			continue
		}

		const bytes = await converted.pptx.read(part.replace(/^\//u, ""))
		const document = parseXml(bytes)

		out.push({
			tree: readTiming({ reader: partReader(document), part, epoch: 0, budgets: BUDGETS }, document.documentElement()),
			xml: new TextDecoder().decode(bytes)
		})
	}

	return out
}

interface Tally {
	effects: number
	equal: number
	slides: number
	sameCount: number
	decks: number
	misses: string[]
}

function tally(): Tally {
	return { effects: 0, equal: 0, slides: 0, sameCount: 0, decks: 0, misses: [] }
}

describe("ppt animations against LibreOffice's animation trees", () => {
	it.skipIf(cache === undefined)(
		"reads ≥ 98% of the corpus's ppt effects as LibreOffice does, both trees and Office 97 builds",
		async () => {
			const index = readLoIndex(cache ?? "").filter(entry => entry.status === "cached" && entry.path.endsWith(".ppt"))
			const trees = tally()
			const builds = tally()

			for (const entry of index) {
				const lo = readLoCache(cache ?? "", entry.sha256)
				const file = join(CORPUS_DIR, entry.path)

				if (lo === undefined || !existsSync(file)) continue

				const loEffects = (lo.deck.slides ?? []).map(slide => theirs(slide.animation))
				const bytes = new Uint8Array(readFileSync(file))
				const timings = await pptTimings(bytes)

				if (timings === undefined) continue

				const file97 = await openPptFile(bytesSource(bytes))
				const target = readSlides(readDocument(file97)).slides.some(slide => slide.timeNodes) ? trees : builds

				if (target === builds && loEffects.every(list => list.length === 0) && timings.every(slide => slide.tree === undefined))
					continue

				target.decks++
				loEffects.forEach((expected, slide) => {
					const actual = ours(timings[slide]?.tree)
					const loNodes = loCount(lo.deck.slides?.[slide]?.animation)

					if (loNodes > 0 || ourCount(timings[slide]?.xml) > 0) {
						target.slides++

						if (ourCount(timings[slide]?.xml) === loNodes) target.sameCount++
						else
							target.misses.push(
								`${entry.path} #${String(slide + 1)} nodes lo ${String(loNodes)} ours ${String(ourCount(timings[slide]?.xml))}`
							)
					}

					for (let k = 0; k < Math.max(expected.length, actual.length); k++) {
						target.effects++

						if (JSON.stringify(expected[k]) === JSON.stringify(actual[k])) target.equal++
						else
							target.misses.push(
								`${entry.path} #${String(slide + 1)}.${String(k)} lo ${JSON.stringify(expected[k])} ours ${JSON.stringify(actual[k])}`
							)
					}
				})
			}

			const summary = (t: Tally): object => ({
				ratio: t.equal / t.effects,
				effects: t.effects,
				decks: t.decks,
				nodes: t.sameCount / t.slides
			})
			const report = process.env["FILEN_OFFICE_ANIM_MISSES"]

			if (report !== undefined)
				writeFileSync(
					report,
					`${JSON.stringify({ trees: summary(trees), builds: summary(builds) })}\n${[...trees.misses, ...builds.misses].join("\n")}`
				)

			expect(trees.decks + builds.decks).toBeGreaterThan(0)
			expect((trees.equal + builds.equal) / (trees.effects + builds.effects)).toBeGreaterThanOrEqual(0.98)
			// A tree is copied node for node; the builds are a sequence of our making, so only their effects compare.
			expect(trees.sameCount / trees.slides).toBeGreaterThanOrEqual(0.98)
		},
		900_000
	)
})
