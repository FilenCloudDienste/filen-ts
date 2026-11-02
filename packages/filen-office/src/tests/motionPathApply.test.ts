import { describe, expect, it } from "vitest"
import type { LayerState, TimingTree } from "../core/anim/model"
import {
	curvePath,
	customPathPreset,
	insertPoint,
	linePath,
	motionBehaviors,
	movePoint,
	polyline,
	polylinePath,
	readEditablePath,
	simplifyStroke,
	writeEditablePath,
	type EditablePath
} from "../core/anim/motionEdit"
import { compile, instantiate } from "../core/anim/timegraph"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { lockedPathOps } from "../core/presentation/edit/apply/motionPath"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Refused, SlideNode } from "../core/presentation/model"
import { authoringHarness, layersOf } from "./animAuthoringFixtures"
import { buildPptx, sp, xfrm } from "./pptxFixtures"
import { odpBytes } from "./odpFixtures"
import { entriesOf, odpApplier, openOdpDeck, saveDeck, slideAt, text as odpText } from "./odpWriteFixtures"
import { openDeck, partsOf, saveEdits, slideNode, text } from "./pptxWriteFixtures"
import type { EditHarness } from "./presentationEditFixtures"

// Custom motion paths through the motionPath family: a drawn path added as an effect, Edit Points as one setPath
// per edit, Lock / Unlock, undo; and what a saved pptx and ODP read back and play.

// The authoring deck's slide (12192000 × 6858000 EMU) and the box its paths move (shape 4).
const SIZE = { cx: 12192000, cy: 6858000 }
const ASPECT = SIZE.cx / SIZE.cy
const BOX = 4
const WIDTH = 1280

function ok(path: EditablePath | Refused): EditablePath {
	if ("reason" in path) throw new Error(`refused: ${path.reason}`)

	return path
}

// The four drawing tools' paths (fractions of the slide, relative to the shape).
function toolPaths(): Record<string, EditablePath> {
	const stroke = new Float64Array(2 * 2000)

	for (let i = 0; i < 2000; i++) {
		const a = (i / 1999) * Math.PI * 3

		stroke[i * 2] = (i / 1999) * 0.4 - 0.2
		stroke[i * 2 + 1] = Math.sin(a) * 0.15
	}

	return {
		line: linePath({ x: 0, y: 0 }, { x: 0.3, y: 0.2 }),
		curve: ok(
			curvePath([
				{ x: 0, y: 0 },
				{ x: 0.1, y: -0.2 },
				{ x: 0.25, y: 0.05 },
				{ x: 0.35, y: -0.1 }
			])
		),
		freeform: ok(
			polylinePath(
				[
					{ x: 0, y: 0 },
					{ x: -0.2, y: 0.1 },
					{ x: -0.1, y: 0.3 },
					{ x: 0.1, y: 0.2 }
				],
				true
			)
		),
		scribble: ok(polylinePath(simplifyStroke(stroke, 0.5 / WIDTH, ASPECT)))
	}
}

// Where the shape's centre is moved by at `progress` of the path, in px at 1280 px wide: measured here along the
// path's own polyline at constant speed, independently of the player.
function expectedAt(path: EditablePath, progress: number, aspect: number = ASPECT): [number, number] {
	const flat = polyline(path, 16)
	const count = flat.length >> 1
	const lengths = [0]

	for (let k = 1; k < count; k++)
		lengths.push(
			(lengths[k - 1] ?? 0) +
				Math.hypot(((flat[k * 2] ?? 0) - (flat[k * 2 - 2] ?? 0)) * aspect, (flat[k * 2 + 1] ?? 0) - (flat[k * 2 - 1] ?? 0))
		)

	const target = (lengths[count - 1] ?? 0) * progress
	let k = 1

	while (k < count - 1 && (lengths[k] ?? 0) < target) k++

	const span = (lengths[k] ?? 0) - (lengths[k - 1] ?? 0)
	const f = span > 0 ? (target - (lengths[k - 1] ?? 0)) / span : 0
	const x = (flat[k * 2 - 2] ?? 0) + ((flat[k * 2] ?? 0) - (flat[k * 2 - 2] ?? 0)) * f
	const y = (flat[k * 2 - 1] ?? 0) + ((flat[k * 2 + 1] ?? 0) - (flat[k * 2 - 1] ?? 0)) * f

	return [x * WIDTH, (y * WIDTH) / aspect]
}

// The player's translation of `shape`'s layer at `progress` of the slide's first (click) effect of 2 s, px at 1280.
function playedAt(slide: SlideNode, shape: number, progress: number, size: { cx: number; cy: number } = SIZE): [number, number] {
	const layers = layersOf(slide)
	const graph = compile(slide, layers, DEFAULT_PRESENTATION_BUDGETS.timing, { slideSize: size })
	const instance = instantiate(graph)
	const layer = Array.from(layers.shapes).indexOf(shape)

	instance.fire({ kind: "slideBegin" }, 0)
	instance.fire({ kind: "next" }, 1000)

	const state = instance.sample(1000 + progress * 2000).find((entry: LayerState) => entry.layer === layer)
	const matrix = state?.matrix ?? [1, 0, 0, 1, 0, 0]
	// Slide px are EMU / 9525 (96 per inch).
	const px = WIDTH / (size.cx / 9525)

	return [(matrix[4] ?? 0) * px, (matrix[5] ?? 0) * px]
}

const PROGRESS = [0, 0.25, 0.5, 0.75, 1]

function expectFollows(slide: SlideNode, path: EditablePath, shape: number = BOX, size: { cx: number; cy: number } = SIZE): void {
	for (const progress of PROGRESS) {
		const [ex, ey] = expectedAt(path, progress, size.cx / size.cy)
		const [px, py] = playedAt(slide, shape, progress, size)

		expect(Math.abs(px - ex), `x at ${String(progress)}`).toBeLessThanOrEqual(0.5)
		expect(Math.abs(py - ey), `y at ${String(progress)}`).toBeLessThanOrEqual(0.5)
	}
}

async function run(h: EditHarness, op: DeckOp | undefined): Promise<SlideNode> {
	if (op === undefined) throw new Error("no op")

	const result = await h.command(op)

	if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)

	return h.slide(0)
}

function rows(timing: TimingTree | undefined) {
	const effects = slideEffects(timing)

	if (effects.kind !== "effects") throw new Error(effects.detail)

	return effects.rows
}

async function addPath(h: EditHarness, path: EditablePath): Promise<SlideNode> {
	const slide = await h.slide(0)

	return run(
		h,
		addEffectsOp(slide.ref, rows(slide.timing), [{ id: BOX }], { preset: customPathPreset(writeEditablePath(path)), aspect: ASPECT })
	)
}

function onlyMotion(slide: SlideNode) {
	const [motion] = motionBehaviors(slide.timing)

	if (motion === undefined) throw new Error("no motion path")

	return motion
}

describe("custom motion paths in a pptx", () => {
	for (const [tool, path] of Object.entries(toolPaths())) {
		it(`${tool}: a drawn path is a custom path effect that plays, saves and plays again after reopening`, async () => {
			const h = await authoringHarness()
			const slide = await addPath(h, path)
			const written = writeEditablePath(path)
			const motion = onlyMotion(slide)

			expect(motion).toMatchObject({
				shape: BOX,
				path: written.path,
				ptsTypes: written.ptsTypes,
				presetID: 0,
				pathEditMode: "relative"
			})
			expectFollows(slide, path)

			const saved = await saveEdits(h, 2)
			const xml = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

			expect(xml).toContain('presetID="0" presetClass="path"')
			expect(xml).toContain(`path="${written.path}"`)
			expect(xml).toContain(`ptsTypes="${written.ptsTypes}"`)

			const reopened = slideNode(await openDeck(saved), 0)

			expect(onlyMotion(reopened)).toMatchObject({ path: written.path, ptsTypes: written.ptsTypes })
			expectFollows(reopened, path)
			h.close()
		})
	}

	it("an Edit Points drag is one setPath: it plays the edited path, undoes in one step and saves unchanged after undo", async () => {
		const h = await authoringHarness()
		const slide = await addPath(h, toolPaths()["curve"] as EditablePath)
		const saved = await saveEdits(h, 2)
		const motion = onlyMotion(slide)
		const edited = movePoint(insertPoint(ok(readEditablePath(motion.path, motion.ptsTypes)), 1, 0.5), 2, 0.2, 0.3)
		const written = writeEditablePath(edited)
		const after = await run(h, { family: "motionPath", kind: "setPath", slide: slide.ref, node: motion.node, ...written })

		expect(onlyMotion(after)).toMatchObject(written)
		expectFollows(after, edited)

		await h.undo()
		expect(onlyMotion(await h.slide(0))).toMatchObject({ path: motion.path, ptsTypes: motion.ptsTypes })

		await h.redo()

		const resaved = await saveEdits(h, 4)
		const reopened = slideNode(await openDeck(resaved), 0)

		expect(onlyMotion(reopened)).toMatchObject(written)
		expectFollows(reopened, edited)
		expect(saved.length).toBeGreaterThan(0)
		h.close()
	})

	it("rewrites only the edited animMotion's attributes: the rest of p:timing keeps its bytes", async () => {
		const h = await authoringHarness()

		await addPath(h, linePath({ x: 0, y: 0 }, { x: 0.1, y: 0 }))

		const first = await saveEdits(h, 2)
		const before = text((await partsOf(first)).get("ppt/slides/slide1.xml"))
		const reopened = await authoringHarness(first)
		const slide = await reopened.slide(0)
		const motion = onlyMotion(slide)
		const edited = writeEditablePath(linePath({ x: 0, y: 0 }, { x: 0.2, y: 0.1 }))

		await run(reopened, {
			family: "motionPath",
			kind: "setPath",
			slide: slide.ref,
			node: motion.node,
			...edited,
			pathEditMode: "fixed"
		})

		const after = text((await partsOf(await saveEdits(reopened, 2))).get("ppt/slides/slide1.xml"))
		const tag = (xml: string): string => /<p:animMotion [^>]*>/u.exec(xml)?.[0] ?? ""

		expect(tag(after)).toContain(`path="${edited.path}"`)
		expect(tag(after)).toContain('pathEditMode="fixed"')
		expect(after.replace(tag(after), "")).toBe(before.replace(tag(before), ""))
		reopened.close()
		h.close()
	})

	it("a locked path stays where it is on the slide when its shape moves; an unlocked one moves with it", async () => {
		const h = await authoringHarness()
		const slide = await addPath(h, linePath({ x: 0, y: 0 }, { x: 0.2, y: 0 }))
		const motion = onlyMotion(slide)

		expect(lockedPathOps(slide, [{ id: BOX, dx: 1219200, dy: 0 }], SIZE)).toEqual([])

		const locked = await run(h, {
			family: "motionPath",
			kind: "setPath",
			slide: slide.ref,
			node: motion.node,
			path: motion.path,
			pathEditMode: "fixed"
		})
		const ops = lockedPathOps(locked, [{ id: BOX, dx: 1219200, dy: -685800 }], SIZE)

		expect(ops).toEqual([
			{ family: "motionPath", kind: "setPath", slide: slide.ref, node: motion.node, path: "M -0.1 0.1 L 0.1 0.1 E", ptsTypes: "AA" }
		])
		h.close()
	})

	// Adds a custom line path on `shape` of slide `index` and locks it.
	async function lockedPath(h: EditHarness, index: number, shape: number): Promise<SlideNode> {
		const slide = await h.slide(index)
		const added = await h.command(
			addEffectsOp(slide.ref, rows(slide.timing), [{ id: shape }], {
				preset: customPathPreset(writeEditablePath(linePath({ x: 0, y: 0 }, { x: 0.2, y: 0 }))),
				aspect: ASPECT
			}) as DeckOp
		)

		expect(added.ok).toBe(true)

		const motion = onlyMotion(await h.slide(index))
		const locked = await h.command({
			family: "motionPath",
			kind: "setPath",
			slide: slide.ref,
			node: motion.node,
			path: motion.path,
			pathEditMode: "fixed"
		})

		expect(locked.ok).toBe(true)

		return h.slide(index)
	}

	it("moving a shape shifts its locked path back in the same step, and one undo puts both back", async () => {
		const h = await authoringHarness()
		const slide = await lockedPath(h, 0, BOX)

		await run(h, {
			family: "shape",
			kind: "setXfrm",
			target: { slide: slide.ref, id: BOX },
			xfrm: { x: 6000000 + 1219200, y: 1000000 - 685800, cx: 1000000, cy: 1000000, rot: 0, flipH: false, flipV: false }
		})

		expect(onlyMotion(await h.slide(0)).path).toBe("M -0.1 0.1 L 0.1 0.1 E")
		expect((await h.undo()).ok).toBe(true)

		const back = await h.slide(0)

		expect(onlyMotion(back).path).toBe("M 0 0 L 0.2 0 E")
		expect(back.shapes.find(shape => shape.id === BOX)?.xfrm).toMatchObject({ x: 6000000, y: 1000000 })
		h.close()
	})

	it("moving a group shifts the locked paths of the shapes inside it", async () => {
		const box = (id: number, x: number): string =>
			sp(id, `Box ${String(id)}`, undefined, `${xfrm(x, 1000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`)
		const h = await authoringHarness(buildPptx({ slides: [{ shapes: box(5, 2000000) + box(BOX, 6000000) }] }))
		const slide = await lockedPath(h, 0, BOX)

		await run(h, { family: "shape", kind: "group", slide: slide.ref, shapes: [5, BOX], id: 50 })

		const grouped = await h.slide(0)
		const group = grouped.shapes.find(shape => shape.id === 50)?.xfrm

		if (group === undefined) throw new Error("no group")

		expect(onlyMotion(grouped).path).toBe("M 0 0 L 0.2 0 E")

		await run(h, { family: "shape", kind: "setXfrm", target: { slide: slide.ref, id: 50 }, xfrm: { ...group, x: group.x + 1219200 } })

		expect(onlyMotion(await h.slide(0)).path).toBe("M -0.1 0 L 0.1 0 E")

		// Twice as wide from its left edge: the box's centre (6.5 M EMU) moves by its distance from that edge.
		const moved = (await h.slide(0)).shapes.find(shape => shape.id === 50)?.xfrm

		if (moved === undefined) throw new Error("no group")

		await run(h, { family: "shape", kind: "setXfrm", target: { slide: slide.ref, id: 50 }, xfrm: { ...moved, cx: moved.cx * 2 } })

		const shift = (6500000 - group.x) / SIZE.cx

		expect(onlyMotion(await h.slide(0)).path).toBe(
			`M ${String(Math.round((-0.1 - shift) * 1e5) / 1e5)} 0 L ${String(Math.round((0.1 - shift) * 1e5) / 1e5)} 0 E`
		)
		h.close()
	})

	it("moving a placeholder that inherits its box shifts its locked path by how far it moved from the inherited box", async () => {
		const h = await authoringHarness()
		// The second slide's title has no box of its own: the master's title box (100, 200, 3000 × 400) places it.
		const slide = await lockedPath(h, 1, 2)

		expect(slide.shapes.find(shape => shape.id === 2)?.xfrm).toBeUndefined()

		await run(h, {
			family: "shape",
			kind: "setXfrm",
			target: { slide: slide.ref, id: 2 },
			xfrm: { x: 100 + 1219200, y: 200, cx: 3000, cy: 400, rot: 0, flipH: false, flipV: false }
		})

		expect(onlyMotion(await h.slide(1)).path).toBe("M -0.1 0 L 0.1 0 E")
		h.close()
	})

	it("refuses a path that is not §19.5.4 syntax or over the motion budget, changing nothing", async () => {
		const h = await authoringHarness()
		const slide = await addPath(h, linePath({ x: 0, y: 0 }, { x: 0.1, y: 0 }))
		const motion = onlyMotion(slide)
		const huge = `M 0 0 ${Array.from({ length: 700 }, (_, i) => `C 0 ${String(i)} 1 1 1 1`).join(" ")} E`

		for (const path of ["M 0 0 Q 1 1 2 2", "<x/>", huge]) {
			const result = await h.command({ family: "motionPath", kind: "setPath", slide: slide.ref, node: motion.node, path })

			expect(result.ok).toBe(false)
		}

		expect((await h.command({ family: "motionPath", kind: "setPath", slide: slide.ref, node: 9999, path: "M 0 0 L 1 0 E" })).ok).toBe(
			false
		)
		expect(onlyMotion(await h.slide(0)).path).toBe(motion.path)
		h.close()
	})
})

const PAGE =
	'<draw:page draw:name="a" draw:master-page-name="M">' +
	'<draw:custom-shape draw:name="Box" svg:x="10cm" svg:y="8cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
	"</draw:page>"

describe("custom motion paths in an ODP", () => {
	for (const [tool, path] of Object.entries(toolPaths())) {
		it(`${tool}: writes anim:animateMotion with SVG path data and reads the same path back`, async () => {
			const opened = await openOdpDeck(odpBytes({ body: PAGE }))
			const apply = odpApplier(opened)
			const slide = slideAt(opened, 0)
			const box = slide.shapes.find(shape => shape.name === "Box")?.id ?? -1
			const written = writeEditablePath(path)
			const aspect = opened.deck.size.cx / opened.deck.size.cy

			expect(
				apply(addEffectsOp(slide.ref, rows(slide.timing), [{ id: box }], { preset: customPathPreset(written), aspect }) as DeckOp)
			).toBeUndefined()

			const saved = await saveDeck(opened)
			const content = odpText((await entriesOf(saved.bytes)).get("content.xml"))
			const svg = written.path.replace(/ E$/u, "")

			expect(content).toContain(`svg:path="${svg}"`)

			const reopened = await openOdpDeck(saved.bytes)
			const motion = onlyMotion(slideAt(reopened, 0))
			const reread = ok(readEditablePath(motion.path, motion.ptsTypes))

			expect(writeEditablePath(reread).path).toBe(written.path)
			expectFollows(slideAt(reopened, 0), path, motion.shape, reopened.deck.size)
		})
	}

	it("an Edit Points setPath on an ODP path writes the edited path", async () => {
		const opened = await openOdpDeck(odpBytes({ body: PAGE }))
		const apply = odpApplier(opened)
		const slide = slideAt(opened, 0)
		const box = slide.shapes.find(shape => shape.name === "Box")?.id ?? -1
		const aspect = opened.deck.size.cx / opened.deck.size.cy

		apply(
			addEffectsOp(slide.ref, [], [{ id: box }], {
				preset: customPathPreset(writeEditablePath(linePath({ x: 0, y: 0 }, { x: 0.1, y: 0 }))),
				aspect
			}) as DeckOp
		)

		const first = await saveDeck(opened)
		const again = await openOdpDeck(first.bytes)
		const motion = onlyMotion(slideAt(again, 0))
		const edited = writeEditablePath(movePoint(ok(readEditablePath(motion.path)), 1, 0.2, 0.1))

		expect(
			odpApplier(again)({ family: "motionPath", kind: "setPath", slide: slideAt(again, 0).ref, node: motion.node, path: edited.path })
		).toBeUndefined()

		const content = odpText((await entriesOf((await saveDeck(again)).bytes)).get("content.xml"))

		expect(content).toContain('svg:path="M 0 0 L 0.2 0.1"')
	})
})
