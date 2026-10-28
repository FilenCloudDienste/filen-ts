import { describe, expect, it } from "vitest"
import type { TimeNode } from "../core/anim/model"
import { presetFromOdf, presetToOdf } from "../core/anim/odf"
import { EFFECT_PRESETS, effectPreset, presetEffect, presetsOf } from "../core/anim/presets/effects/index"
import {
	addEffectsOp,
	effectNodes,
	effectTimingOp,
	moveEffectOp,
	removeEffectsOp,
	replaceEffectOp,
	slideEffects,
	stepDurations,
	type EffectRow
} from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { authoringHarness, canonicalIds, stateOf, stepEnds } from "./animAuthoringFixtures"
import { openDeck, partsOf, saveEdits, slideNode, text } from "./pptxWriteFixtures"
import type { EditHarness } from "./presentationEditFixtures"

// Authoring a slide's animations: our presets, the effect ops (add, remove, move, time, trigger) on the slide's
// sequences, their undo, and what a saved deck reads back.

const ASPECT = 4 / 3

function preset(presetClass: string, id: number) {
	const found = effectPreset(presetClass, id)

	if (found === undefined) throw new Error(`no preset ${presetClass} ${String(id)}`)

	return found
}

function rowsOf(slide: SlideNode): readonly EffectRow[] {
	const effects = slideEffects(slide.timing)

	if (effects.kind !== "effects") throw new Error(effects.detail)

	return effects.rows
}

async function run(h: EditHarness, op: DeckOp | undefined): Promise<SlideNode> {
	if (op === undefined) throw new Error("no op")

	const result = await h.command(op)

	if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)

	return h.slide(0)
}

async function added(h: EditHarness, presetClass: string, id: number, shapes: readonly number[], start?: "click" | "with" | "after") {
	const slide = await h.slide(0)

	return run(
		h,
		addEffectsOp(
			slide.ref,
			rowsOf(slide),
			shapes.map(shape => ({ id: shape })),
			{ preset: preset(presetClass, id), aspect: ASPECT },
			start
		)
	)
}

function shapesOf(effect: TimeNode): number[] {
	const out = new Set<number>()
	const stack = [effect]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (node.kind === "behavior" && "common" in node.behavior && node.behavior.common.target.kind !== "slide")
			out.add((node.behavior.common.target as { shape: number }).shape)

		stack.push(...node.ctn.children)
	}

	return [...out]
}

describe("effect presets", () => {
	it("offers 30 entrances, 20 emphases, 30 exits and 24 motion paths, each once", () => {
		expect([presetsOf("entr").length, presetsOf("emph").length, presetsOf("exit").length, presetsOf("path").length]).toEqual([
			30, 20, 30, 24
		])
		expect(new Set(EFFECT_PRESETS.map(p => `${p.presetClass}:${String(p.id)}`)).size).toBe(104)
	})

	it("names every preset and subtype with LibreOffice's preset names, which read back as the same numbers", () => {
		for (const p of EFFECT_PRESETS) {
			for (const subtype of p.subtypes.length === 0 ? [0] : p.subtypes) {
				const odf = presetToOdf(p.presetClass, p.id, subtype)

				expect(odf.id, `${p.presetClass} ${String(p.id)}`).toMatch(/^ooo-/u)
				expect(presetFromOdf(odf.id, odf.subtype), `${p.presetClass} ${String(p.id)} ${String(subtype)}`).toEqual({
					presetClass: p.presetClass,
					id: p.id,
					...(subtype === 0 ? {} : { subtype })
				})
			}
		}
	})

	it("builds every preset at the duration asked for", () => {
		for (const p of EFFECT_PRESETS) {
			const effect = presetEffect({
				preset: p,
				target: { kind: "shape", shape: 4 },
				start: "click",
				durationMs: 1500,
				aspect: ASPECT
			})
			const longest = Math.max(
				...effect.ctn.children.map(
					child => (typeof child.ctn.dur === "number" ? child.ctn.dur : 0) + Number(child.ctn.stCondLst[0]?.delay ?? 0)
				)
			)

			expect(effect.ctn.presetID).toBe(p.id)
			expect(effect.ctn.children.length).toBeGreaterThan(0)
			// Appear and Disappear are a single 1 ms set.
			if (p.durationMs > 1) expect(Math.abs(longest - 1500), p.name).toBeLessThanOrEqual(1)
		}
	})
})

describe("effect ops", () => {
	it("adds an entrance on click to a slide without timing, which then waits for one click", async () => {
		const h = await authoringHarness()
		const slide = await added(h, "entr", 2, [4])
		const rows = rowsOf(slide)

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			sequence: 0,
			start: "click",
			step: 1,
			presetClass: "entr",
			presetID: 2,
			presetSubtype: 4,
			shape: 4
		})
		expect(slide.timing?.root.ctn.nodeType).toBe("tmRoot")

		const ends = stepEnds(slide)

		expect(ends.steps).toBe(1)
		// The box (third layer) is hidden before the click and shown after it.
		expect(stateOf(ends.samples[0], 2)?.visible).toBe(false)
		expect(stateOf(ends.samples[1], 2)?.visible ?? true).toBe(true)
		h.close()
	})

	it("groups with-previous and after-previous effects into the click before them, after ones at the end of the group before", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 10, [2])
		await added(h, "entr", 10, [3], "with")

		const slide = await added(h, "emph", 8, [4], "after")
		const rows = rowsOf(slide)

		expect(rows.map(row => [row.start, row.step, row.beginMs])).toEqual([
			["click", 1, 0],
			["with", 1, 0],
			["after", 1, 500]
		])

		const main = slide.timing?.root.ctn.children[0]

		expect(main?.ctn.children).toHaveLength(1)
		expect(main?.ctn.children[0]?.ctn.children.map(group => group.ctn.stCondLst[0]?.delay)).toEqual([0, 500])
		h.close()
	})

	it("starts a slide's first with-previous effect with the slide, before any click", async () => {
		const h = await authoringHarness()
		const slide = await added(h, "entr", 10, [4], "with")

		expect(rowsOf(slide)[0]).toMatchObject({ start: "with", step: 0 })
		expect(stepEnds(slide).steps).toBe(0)
		expect(stateOf(stepEnds(slide).samples[0], 2)?.visible ?? true).toBe(true)
		h.close()
	})

	it("adds one effect per shape for a selection, the first on click and the rest with it", async () => {
		const h = await authoringHarness()
		const slide = await added(h, "entr", 10, [2, 3, 4])

		expect(rowsOf(slide).map(row => [row.shape, row.start, row.step])).toEqual([
			[2, "click", 1],
			[3, "with", 1],
			[4, "with", 1]
		])
		h.close()
	})

	it("animates text by paragraph with one effect per paragraph and the PowerPoint build", async () => {
		const h = await authoringHarness()
		const before = await h.slide(0)
		const slide = await run(
			h,
			addEffectsOp(before.ref, rowsOf(before), [{ id: 3, paragraphs: 2 }], {
				preset: preset("entr", 10),
				byParagraph: true,
				aspect: ASPECT
			})
		)
		const rows = rowsOf(slide)

		expect(rows.map(row => [row.paragraph, row.step, row.grpId])).toEqual([
			[0, 1, 0],
			[1, 2, 0]
		])
		expect(slide.timing?.builds).toEqual([{ kind: "bldP", shape: 3, grpId: 0, build: "p" }])
		expect(stepEnds(slide).steps).toBe(2)
		h.close()
	})

	it("removes an effect and puts it back where it was on undo", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 10, [2])
		await added(h, "entr", 2, [3])

		const full = await added(h, "exit", 10, [4])
		const tree = JSON.stringify(full.timing)
		const middle = rowsOf(full)[1] as EffectRow
		const removed = await run(h, removeEffectsOp(full.ref, [middle.id]))

		expect(rowsOf(removed).map(row => row.shape)).toEqual([2, 4])
		await h.undo()
		expect(JSON.stringify((await h.slide(0)).timing)).toBe(tree)
		h.close()
	})

	it("moves an effect within its sequence and back on undo", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 10, [2])
		await added(h, "entr", 10, [3])

		const slide = await added(h, "entr", 10, [4])
		const last = rowsOf(slide)[2] as EffectRow
		const moved = await run(h, moveEffectOp(slide.ref, last.id, 0))

		expect(rowsOf(moved).map(row => row.shape)).toEqual([4, 2, 3])
		await h.undo()
		expect(rowsOf(await h.slide(0)).map(row => row.shape)).toEqual([2, 3, 4])
		h.close()
	})

	it("times an effect: start, delay, duration, repeat, rewind, and undoes it whole", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 10, [2])

		const slide = await added(h, "entr", 2, [4])
		const row = rowsOf(slide)[1] as EffectRow
		const before = JSON.stringify(slide.timing)
		const timed = await run(
			h,
			effectTimingOp(slide.ref, [row.id], { start: "after", delayMs: 250, durationMs: 2000, repeat: 3, rewind: true })
		)
		const after = rowsOf(timed)[1] as EffectRow

		expect(after).toMatchObject({ start: "after", step: 1, delayMs: 250, durationMs: 2000, repeat: 3, rewind: true, beginMs: 750 })
		expect(stepDurations(rowsOf(timed))).toEqual([0, 750 + 2000 * 3])

		const untilNext = await run(h, effectTimingOp(slide.ref, [row.id], { repeat: "untilNextClick" }))

		expect((rowsOf(untilNext)[1] as EffectRow).repeat).toBe("untilNextClick")
		await h.undo()
		await h.undo()
		expect(JSON.stringify((await h.slide(0)).timing)).toBe(before)
		h.close()
	})

	it("moves an effect to a trigger's interactive sequence and back", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 10, [2])

		const slide = await added(h, "emph", 8, [4])
		const spin = rowsOf(slide)[1] as EffectRow
		const triggered = await run(h, effectTimingOp(slide.ref, [spin.id], { trigger: { kind: "shapeClick", shape: 2 } }))
		const rows = rowsOf(triggered)

		expect(rows.map(row => [row.sequence, row.trigger, row.step])).toEqual([
			[0, undefined, 1],
			[1, 2, 1]
		])

		const back = await run(h, effectTimingOp(slide.ref, [spin.id], { trigger: { kind: "none" } }))

		expect(rowsOf(back).map(row => row.sequence)).toEqual([0, 0])
		await h.undo()
		await h.undo()
		expect(JSON.stringify((await h.slide(0)).timing)).toBe(JSON.stringify(slide.timing))
		h.close()
	})

	it("puts a triggered effect back into its interactive sequence on undo", async () => {
		const h = await authoringHarness()
		const slide = await added(h, "emph", 8, [4])
		const spin = rowsOf(slide)[0] as EffectRow
		const triggered = await run(h, effectTimingOp(slide.ref, [spin.id], { trigger: { kind: "shapeClick", shape: 2 } }))
		const tree = canonicalIds(triggered.timing)

		await run(h, removeEffectsOp(slide.ref, [spin.id]))
		expect((await h.slide(0)).timing).toBeUndefined()
		await h.undo()
		expect(canonicalIds((await h.slide(0)).timing)).toBe(tree)
		h.close()
	})

	it("replaces an effect with another preset where it was, keeping its timing", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 10, [2])
		await added(h, "entr", 2, [4], "after")

		const slide = await h.slide(0)
		const fly = rowsOf(slide)[1] as EffectRow
		const replaced = await run(
			h,
			replaceEffectOp(slide.ref, rowsOf(slide), fly, { preset: preset("entr", 22), subtype: 8, aspect: ASPECT })
		)

		expect(rowsOf(replaced).map(row => [row.presetID, row.presetSubtype, row.start])).toEqual([
			[10, 0, "click"],
			[22, 8, "after"]
		])
		h.close()
	})

	it("refuses an effect op on an effect the slide does not have", async () => {
		const h = await authoringHarness()
		const slide = await h.slide(0)
		const result = await h.command({ family: "timing", kind: "removeEffect", slide: slide.ref, node: 99 })

		expect(result.ok).toBe(false)
		h.close()
	})
})

describe("authored effects in a saved pptx", () => {
	it("writes a slide's new timing and reads back the same effects and step ends", async () => {
		const h = await authoringHarness()

		await added(h, "entr", 2, [2])
		await added(h, "emph", 1, [4], "after")
		await added(h, "path", 63, [4])

		const slide = await added(h, "exit", 10, [3], "with")
		const saved = await saveEdits(h, 4)
		const reopened = slideNode(await openDeck(saved), 0)
		const xml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(xml).toContain('presetClass="path"')
		expect(xml).toContain("<p:bldLst>")
		expect(rowsOf(reopened).map(row => [row.presetClass, row.presetID, row.presetSubtype, row.start, row.step])).toEqual(
			rowsOf(slide).map(row => [row.presetClass, row.presetID, row.presetSubtype, row.start, row.step])
		)
		expect(stepEnds(reopened)).toEqual(stepEnds(slide))
		expect(effectNodes(reopened.timing).flatMap(shapesOf)).toEqual(effectNodes(slide.timing).flatMap(shapesOf))
		h.close()
	})
})
