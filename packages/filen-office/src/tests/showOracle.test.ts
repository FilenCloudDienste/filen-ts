import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { PresetClass, TimeNode, TimingTree } from "../core/anim/model"
import { presetToOdf } from "../core/anim/odf"
import { compile } from "../core/anim/timegraph"
import { openOdp } from "../core/odp/read/document"
import { bytesSource } from "../core/opc/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import type { SlideNode } from "../core/presentation/model"
import { openPptx } from "../core/pptx/package"
import { showLayerIndex } from "../dom/presentation/engine/show"
import { CORPUS_DIR } from "./corpusDir"
import { loCacheDir, readLoCache, readLoIndex, type LoAnimationNode } from "./oracles/presentation/lo"

// The show's main-sequence steps against LibreOffice 7.5's animation trees (XAnimationNode over UNO, the oracle
// cache's lo.json) for every animated pptx-family and odp deck of the corpus: per slide, the effects each click
// starts, in order (an on-click effect opens a step; with- and after-previous effects join the open one; effects
// before the first click play on the slide's start, step 0). Ours are the steps the player plays: the main
// sequence's children a "next" begins (the compiled graph's mainSteps rule), and the graph's step count is checked
// equal to them. Opt in with FILEN_OFFICE_LO_CACHE.

const cache = loCacheDir()
const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing
const OOXML = /\.(pptx|pptm|potx|potm|ppsx|ppsm)$/iu
const LO_CLASSES: Readonly<Record<string, PresetClass>> = {
	"1": "entr",
	"2": "exit",
	"3": "emph",
	"4": "path",
	"5": "verb",
	"6": "mediacall"
}
const CLASSES: Readonly<Record<string, string>> = { entr: "1", exit: "2", emph: "3", path: "4", verb: "5", mediacall: "6" }
const EFFECT_TYPES = new Set(["clickEffect", "withEffect", "afterEffect"])

type Steps = string[][]

function effectKey(presetClass: string, id: string | undefined, subtype: string | undefined): string {
	return `${presetClass}:${id ?? ""}:${subtype ?? ""}`
}

// Ours: the main sequence's children; a child a "next" begins opens a step.
// LibreOffice 7.5 names a media-call effect only from a .ppt (sd's import writes "ppt_mediacall_1", which our
// conversion writes for every source); its pptx import has no media-call preset names (oox's preset_mapping), so it
// reports none for a pptx deck.
function ourSteps(tree: TimingTree | undefined, pptx: boolean): Steps {
	const steps: Steps = []
	const find = (node: TimeNode): TimeNode | undefined =>
		node.ctn.nodeType === "mainSeq" ? node : node.ctn.children.map(find).find(found => found !== undefined)
	const main = tree === undefined ? undefined : find(tree.root)

	for (const child of main?.ctn.children ?? []) {
		const waits = waitsForNext(child)
		const effects: string[] = []
		const visit = (node: TimeNode): void => {
			const ctn = node.ctn

			if (ctn.nodeType !== undefined && EFFECT_TYPES.has(ctn.nodeType)) {
				const preset = presetToOdf(ctn.presetClass, ctn.presetID, ctn.presetSubtype)

				effects.push(
					effectKey(
						ctn.presetClass === undefined ? "0" : (CLASSES[ctn.presetClass] ?? "0"),
						pptx && ctn.presetClass === "mediacall" ? undefined : (preset.id ?? ctn.presetName),
						preset.subtype ?? ctn.presetSubtypeName
					)
				)

				return
			}

			for (const next of ctn.children) visit(next)
		}

		visit(child)

		if (waits || steps.length === 0) steps.push(effects)
		else steps[steps.length - 1]?.push(...effects)
	}

	return steps.filter((step, k) => step.length > 0 || k > 0)
}

// LibreOffice's: the main sequence's effects in order (node-type 4 is the main sequence, 1 on click).
function theirSteps(root: LoAnimationNode | undefined): Steps {
	const find = (node: LoAnimationNode): LoAnimationNode | undefined =>
		node["node-type"] === "4" ? node : (node.children ?? []).map(find).find(found => found !== undefined)
	const main = root === undefined ? undefined : find(root)
	const steps: Steps = []
	const visit = (node: LoAnimationNode): void => {
		const type = node["node-type"]

		if (type === "1" || type === "2" || type === "3") {
			const id = node["preset-id"]
			const presetClass = node["preset-class"] ?? "0"
			const subtype = node["preset-sub-type"]
			const numeric =
				id !== undefined && /^\d+$/u.test(id)
					? presetToOdf(
							LO_CLASSES[presetClass],
							Number(id),
							subtype !== undefined && /^\d+$/u.test(subtype) ? Number(subtype) : undefined
						)
					: undefined
			const key = effectKey(
				presetClass,
				numeric !== undefined ? numeric.id : id === "" ? undefined : id,
				numeric !== undefined ? numeric.subtype : subtype === "" || subtype === "0" ? undefined : subtype
			)

			if (type === "1" || steps.length === 0) steps.push([key])
			else steps[steps.length - 1]?.push(key)

			return
		}

		for (const child of node.children ?? []) visit(child)
	}

	if (main !== undefined) visit(main)

	return steps
}

async function slides(path: string, bytes: Uint8Array): Promise<SlideNode[]> {
	const open = path.endsWith(".odp") ? await openOdp(bytesSource(bytes)) : await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") return []

	const out: SlideNode[] = []

	for (const ref of open.deck.slides) out.push(await open.parts.slide(ref))

	return out
}

describe("show steps against LibreOffice's animation trees", () => {
	it.skipIf(cache === undefined)(
		"plays the main sequence in LibreOffice's step order on the corpus's animated decks",
		async () => {
			const index = readLoIndex(cache ?? "").filter(
				entry => entry.status === "cached" && (OOXML.test(entry.path) || entry.path.endsWith(".odp"))
			)
			let decks = { pptx: 0, odp: 0 }
			// Decks with animations but no main sequence (only triggers): nothing a click steps through.
			const triggersOnly: string[] = []
			let compared = 0
			let equal = 0
			const misses: string[] = []

			for (const entry of index) {
				const lo = readLoCache(cache ?? "", entry.sha256)
				const file = join(CORPUS_DIR, entry.path)
				const loSlides = lo?.deck.slides ?? []

				if (lo === undefined || !existsSync(file)) continue
				if (!loSlides.some(slide => theirSteps(slide.animation).length > 0)) {
					if (loSlides.some(slide => slide.animation !== undefined && (slide.animation.children ?? []).length > 0))
						triggersOnly.push(entry.path)

					continue
				}

				const nodes = await slides(entry.path, new Uint8Array(readFileSync(file)))
				const odp = entry.path.endsWith(".odp")

				decks = { pptx: decks.pptx + (odp ? 0 : 1), odp: decks.odp + (odp ? 1 : 0) }

				loSlides.forEach((slide, k) => {
					const expected = theirSteps(slide.animation)
					const node = nodes[k]

					if (expected.length === 0 || node === undefined) return

					const actual = ourSteps(node.timing, !odp)
					// The steps the player gives "next" (an auto step 0 is not one).
					const graph = compile(node, showLayerIndex(node.timing), BUDGETS)
					const clicks = actual.length - (waitsFirst(node.timing) ? 0 : 1)

					compared++

					if (sameSteps(actual, expected) && graph.mainSteps === clicks) equal++
					else
						misses.push(
							`${entry.path} #${String(k + 1)} lo ${JSON.stringify(expected)} ours ${JSON.stringify(actual)} mainSteps ${String(graph.mainSteps)}`
						)
				})
			}

			if (process.env["FILEN_OFFICE_SHOW_MISSES"] !== undefined)
				writeFileSync(
					process.env["FILEN_OFFICE_SHOW_MISSES"],
					`${JSON.stringify({ decks, compared, equal, triggersOnly })}\n${misses.join("\n")}`
				)

			expect(decks.pptx).toBeGreaterThanOrEqual(26)
			// The odp decks with a main sequence (two more animate only by triggers or media, listed in triggersOnly).
			expect(decks.odp).toBeGreaterThanOrEqual(13)
			expect({ equal, compared, misses }).toEqual({ equal: compared, compared, misses: [] })
		},
		600_000
	)
})

// The same steps with the same effects in the same order. LibreOffice's tree has no preset for the effects of some
// legacy decks (class 0, no id): a step of only those matches any step of ours.
function sameSteps(ours: Steps, theirs: Steps): boolean {
	return (
		ours.length === theirs.length &&
		ours.every((step, k) => {
			const other = theirs[k] ?? []

			// A legacy group LibreOffice folds into one preset-less effect (a build by paragraph) is one step all the same.
			if (other.length > 0 && other.every(effect => effect === "0::")) return step.length > 0

			return step.length === other.length && step.every((effect, j) => other[j] === effect)
		})
	)
}

// Whether a main-sequence child waits for a click: an indefinite begin or a "next", and no begin on another node
// (PowerPoint's first group of an after-previous start also names the main sequence's begin: it plays at once).
function waitsForNext(node: TimeNode): boolean {
	const conditions = node.ctn.stCondLst

	return conditions.some(c => c.delay === "indefinite" || c.evt === "onNext") && !conditions.some(c => c.tn !== undefined)
}

// Whether the main sequence's first child waits for a click (else its effects play on the slide's start).
function waitsFirst(tree: TimingTree | undefined): boolean {
	const find = (node: TimeNode): TimeNode | undefined =>
		node.ctn.nodeType === "mainSeq" ? node : node.ctn.children.map(find).find(found => found !== undefined)
	const first = tree === undefined ? undefined : find(tree.root)?.ctn.children[0]

	return first !== undefined && waitsForNext(first)
}
