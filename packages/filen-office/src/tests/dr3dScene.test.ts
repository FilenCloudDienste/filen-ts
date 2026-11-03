import { describe, expect, it } from "vitest"
import { DrawingList, ItemKind } from "../core/drawingml/displayList"
import { drawScene, readScene, transform3d, type Dr3dScene, type SceneSource } from "../core/metafile/dr3d"
import { parseXml, type XmlDocument } from "../core/xml/index"
import { budget, cpuMs } from "./timing"

const NS =
	'xmlns:dr3d="urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"'
const CAMERA = 'dr3d:vrp="(0 0 16885.7142857143)" dr3d:projection="perspective" dr3d:shade-mode="gouraud" dr3d:ambient-color="#666666"'
const LIGHT =
	'<dr3d:light dr3d:diffuse-color="#cccccc" dr3d:direction="(0.57735026918963 0.57735026918963 0.57735026918963)" dr3d:enabled="true" dr3d:specular="true"/>'

// Graphic styles by name: [own properties, parent].
type Styles = Record<string, [Record<string, string>, string | undefined]>

function source(document: XmlDocument, styles: Styles): SceneSource {
	const attributes = (node: number): ReadonlyMap<string, string> =>
		new Map(document.attributes(node).map(a => [a.name, a.value] as const))

	return {
		name: node => document.name(node),
		attributes,
		firstChild: node => document.firstChildElement(node),
		nextSibling: node => document.nextSiblingElement(node),
		style(name) {
			const resolved = new Map<string, string>()
			const chain: Record<string, string>[] = []

			for (let at = name, guard = 0; at !== undefined && guard < 8; guard++) {
				const style = styles[at]

				if (style === undefined) break

				chain.unshift(style[0])
				at = style[1]
			}

			for (const own of chain) for (const [key, value] of Object.entries(own)) resolved.set(key, value)

			return { resolved, own: new Map(Object.entries(name === undefined ? {} : (styles[name]?.[0] ?? {}))) }
		}
	}
}

function scene(xml: string, styles: Styles = {}): Dr3dScene | undefined {
	const document = parseXml(new TextEncoder().encode(`<dr3d:scene ${NS} ${CAMERA} draw:style-name="scene">${LIGHT}${xml}</dr3d:scene>`))

	return readScene(
		source(document, {
			scene: [{ "draw:fill-color": "#00b8ff" }, "standard"],
			standard: [{ "draw:fill-color": "#729fcf" }, undefined],
			...styles
		}),
		document.documentElement()
	)
}

function drawn(value: Dr3dScene, width = 200, height = 200): { points: Float32Array; colors: Uint32Array } {
	const list = new DrawingList()

	expect(drawScene(list, value, [1, 0, 0, 1, 0, 0], width, height)).toBe(true)
	expect(list.itemCount).toBe(1)
	expect(list.kind(0)).toBe(ItemKind.PATH)

	const paint = list.paints[0]

	if (paint?.kind !== "shaded") throw new Error("not a shaded paint")

	return paint
}

function bounds(points: Float32Array): [number, number, number, number] {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (let k = 0; k < points.length; k += 2) {
		minX = Math.min(minX, points[k] ?? 0)
		maxX = Math.max(maxX, points[k] ?? 0)
		minY = Math.min(minY, points[k + 1] ?? 0)
		maxY = Math.max(maxY, points[k + 1] ?? 0)
	}

	return [minX, minY, maxX, maxY]
}

describe("ODF 3D scenes", () => {
	it("fits a cube's projected bounding box to the frame and hides its far faces", () => {
		const value = scene('<dr3d:cube draw:style-name="cube"/>', { cube: [{ "draw:stroke": "none" }, "standard"] })

		if (value === undefined) throw new Error("no scene")

		const { points } = drawn(value, 204, 214)
		const [minX, minY, maxX, maxY] = bounds(points)

		expect(minX).toBeCloseTo(0, 3)
		expect(minY).toBeCloseTo(0, 3)
		expect(maxX).toBeCloseTo(204, 3)
		expect(maxY).toBeCloseTo(214, 3)
		// The front face only (two triangles), seen straight on.
		expect(points.length / 6).toBe(2)
	})

	it("leaves a sphere the margin its bounding box's perspective gives it", () => {
		const value = scene('<dr3d:sphere draw:style-name="ball"/>', { ball: [{}, "standard"] })

		if (value === undefined) throw new Error("no scene")

		const [minX, , maxX] = bounds(drawn(value, 160, 160).points)
		// The box's front corners reach (D - r) where the silhouette reaches sqrt(D² - r²): about 1.16 times wider.
		const ratio = 160 / (maxX - minX)

		expect(ratio).toBeGreaterThan(1.12)
		expect(ratio).toBeLessThan(1.2)
	})

	it("gives members the scene's fill unless their own style sets one, and lights them by the scene's light", () => {
		const inherited = scene('<dr3d:cube draw:style-name="cube"/>', { cube: [{}, "standard"] })
		const own = scene('<dr3d:cube draw:style-name="red"/>', { red: [{ "draw:fill-color": "#ff0000" }, "standard"] })

		expect(inherited?.objects[0]?.material.diffuse).toBe(0x00b8ff)
		expect(own?.objects[0]?.material.diffuse).toBe(0xff0000)

		// The face's corner nearest the light is the brightest.
		const { colors } = drawn(own as Dr3dScene)
		const red = Array.from(colors, color => color >>> 24)

		expect(Math.max(...red)).toBeGreaterThan(Math.min(...red))
	})

	it("turns a profile about the y axis with the segments its style asks for", () => {
		const value = scene('<dr3d:rotate draw:style-name="cone" svg:viewBox="0 -5000 2500 10000" svg:d="m0 5000 2500-10000h-2500"/>', {
			cone: [{ "dr3d:horizontal-segments": "4" }, "standard"]
		})

		if (value === undefined) throw new Error("no scene")

		const object = value.objects[0]

		expect(object?.kind).toBe("rotate")
		expect(object?.kind === "rotate" ? object.around : 0).toBe(4)

		const { points } = drawn(value)

		expect(points.length / 6).toBeGreaterThan(0)
		expect(points.length / 6).toBeLessThanOrEqual(16)
	})

	it("reads dr3d:transform as SVG does, the matrix's columns first", () => {
		expect(
			transform3d("matrix (1 0 0 0 0.939692620786134 -0.342020143325049 0 0.342020143325049 0.939692620786134 0cm 0cm 1cm)")
		).toEqual([1, 0, 0, 0, 0, 0.939692620786134, 0.342020143325049, 0, 0, -0.342020143325049, 0.939692620786134, 1000])
		expect(transform3d("rotatey(90deg)")[2]).toBeCloseTo(1, 9)
	})

	it("draws nothing for a scene past its triangle budget", () => {
		const balls = '<dr3d:sphere draw:style-name="ball"/>'.repeat(8)
		const value = scene(balls, { ball: [{ "dr3d:horizontal-segments": "256", "dr3d:vertical-segments": "256" }, "standard"] })

		expect(drawScene(new DrawingList(), value as Dr3dScene, [1, 0, 0, 1, 0, 0], 100, 100)).toBe(false)
	})

	it("draws an equal scene at the same size from one mesh, and only then", () => {
		const xml = '<dr3d:rotate draw:style-name="cone" svg:d="m0 5000 2500-10000h-2500"/>'
		const styles: Styles = { cone: [{ "dr3d:horizontal-segments": "60" }, "standard"] }
		const first = scene(xml, styles)
		const second = scene(xml, styles)
		const red = scene(xml, { cone: [{ "dr3d:horizontal-segments": "60", "draw:fill-color": "#ff0000" }, "standard"] })

		if (first === undefined || second === undefined || red === undefined) throw new Error("no scene")

		const list = new DrawingList()

		expect(drawScene(list, first, [1, 0, 0, 1, 0, 0], 120, 80)).toBe(true)
		expect(drawScene(list, second, [1, 0, 0, 1, 50, 0], 120, 80)).toBe(true)
		expect(list.paints.length).toBe(1)
		expect(list.itemCount).toBe(2)

		const shaded = (value: Dr3dScene, width: number): { points: Float32Array; colors: Uint32Array } => {
			const other = new DrawingList()

			drawScene(other, value, [1, 0, 0, 1, 0, 0], width, 80)

			const paint = other.paints[0]

			if (paint?.kind !== "shaded") throw new Error("no mesh")

			return paint
		}
		const held = shaded(first, 120)

		// Equal content, each drawing its own arrays: a render's buffers are transferred away (detached) after it.
		expect(shaded(second, 120)).toEqual(held)
		expect(shaded(second, 120).points).not.toBe(held.points)
		// Another size or another material is another mesh.
		expect(shaded(first, 121).points).not.toEqual(held.points)
		expect(shaded(red, 120).colors).not.toEqual(held.colors)
		structuredClone(held, { transfer: [held.points.buffer as ArrayBuffer, held.colors.buffer as ArrayBuffer] })
		expect(shaded(first, 120).points.length).toBeGreaterThan(0)
	})

	it("draws one 360-triangle scene 400 times in at most 40 ms of CPU", () => {
		const value = scene('<dr3d:sphere draw:style-name="ball"/>', {
			ball: [{ "dr3d:horizontal-segments": "15", "dr3d:vertical-segments": "13" }, "standard"]
		})

		if (value === undefined) throw new Error("no scene")

		const start = cpuMs()

		for (let k = 0; k < 400; k++) drawScene(new DrawingList(), value, [1, 0, 0, 1, 0, 0], 200, 200)

		expect(cpuMs() - start).toBeLessThan(budget(40))
	})

	it("reads nothing from a scene without members", () => {
		expect(scene("")).toBeUndefined()
	})
})
