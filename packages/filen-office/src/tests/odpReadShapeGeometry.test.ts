import { describe, expect, it } from "vitest"
import { PATH_CLOSE, PATH_LINE, PATH_MOVE, type CustomPath, type ShapeNode } from "../core/presentation/model"
import { openOdpFixture, page, slideOf } from "./odpFixtures"

const EMU_PER_CM = 360_000

async function shapesOf(content: string): Promise<readonly ShapeNode[]> {
	return (await slideOf(await openOdpFixture({ body: page(content) }), 0)).shapes
}

// A custom path's points in its path space.
function points(path: CustomPath | undefined): [number, number][] {
	const coords = path?.coords ?? new Float64Array()
	const out: [number, number][] = []

	for (let k = 0; k + 1 < coords.length; k += 2) out.push([coords[k] ?? 0, coords[k + 1] ?? 0])

	return out
}

describe("ODP reader shape geometry", () => {
	it("reads a routed connector's svg:d (absolute 1/100 mm) as its bends, boxed on the path's bounds", async () => {
		const [routed] = await shapesOf(
			'<draw:connector draw:type="standard" svg:x1="1cm" svg:y1="1cm" svg:x2="5cm" svg:y2="4cm" ' +
				'svg:d="M1000 1000h2000v3000h2000" svg:viewBox="0 0 4001 3001"/>'
		)

		expect(routed?.kind).toBe("cxnSp")
		expect(routed?.xfrm).toMatchObject({ x: EMU_PER_CM, y: EMU_PER_CM, cx: 4 * EMU_PER_CM, cy: 3 * EMU_PER_CM, rot: 0 })

		const geometry = routed?.props?.geometry

		expect(geometry?.kind).toBe("custom")
		if (geometry?.kind !== "custom") return

		const [path] = geometry.paths

		expect(path?.fill).toBe("none")
		expect(Array.from(path?.commands ?? [])).toEqual([PATH_MOVE, PATH_LINE, PATH_LINE, PATH_LINE])
		expect(points(path)).toEqual([
			[0, 0],
			[50_000, 0],
			[50_000, 75_000],
			[100_000, 75_000]
		])
		expect([path?.w, path?.h]).toEqual([100_000, 75_000])
	})

	it("boxes a routed connector on its ends too when they lie outside the path", async () => {
		const [routed] = await shapesOf('<draw:connector svg:x1="0cm" svg:y1="2cm" svg:x2="6cm" svg:y2="2cm" svg:d="M1000 2000h4000"/>')

		// A path straight between its ends is the line it draws.
		expect(routed?.props?.geometry).toEqual({ kind: "preset", preset: "line", guides: [] })
		expect(routed?.xfrm).toMatchObject({ x: 0, y: 2 * EMU_PER_CM, cx: 6 * EMU_PER_CM, cy: 0 })

		const [bent] = await shapesOf('<draw:connector svg:x1="0cm" svg:y1="0cm" svg:x2="4cm" svg:y2="4cm" svg:d="M1000 1000h1000v1000"/>')

		expect(bent?.props?.geometry?.kind).toBe("custom")
		expect(bent?.xfrm).toMatchObject({ x: 0, y: 0, cx: 4 * EMU_PER_CM, cy: 4 * EMU_PER_CM })
	})

	it("keeps a connector without svg:d the straight line between its ends", async () => {
		const [line] = await shapesOf('<draw:connector svg:x1="5cm" svg:y1="1cm" svg:x2="1cm" svg:y2="3cm"/>')

		expect(line?.props?.geometry).toEqual({ kind: "preset", preset: "line", guides: [] })
		expect(line?.xfrm).toMatchObject({ x: EMU_PER_CM, y: EMU_PER_CM, cx: 4 * EMU_PER_CM, cy: 2 * EMU_PER_CM, flipH: true })
	})

	it("reads a regular polygon of any corner count as that many vertices, the first at the top centre", async () => {
		const polygon = (corners: number): string =>
			`<draw:regular-polygon draw:corners="${String(corners)}" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="4cm"/>`
		const shapes = await shapesOf([3, 4, 5, 7, 9, 12].map(polygon).join(""))

		for (const [k, corners] of [3, 4, 5, 7, 9, 12].entries()) {
			const geometry = shapes[k]?.props?.geometry

			expect(geometry?.kind).toBe("custom")
			if (geometry?.kind !== "custom") continue

			const [path] = geometry.paths
			const vertices = points(path)

			expect(vertices).toHaveLength(corners)
			expect(path?.fill).toBe("norm")
			expect(path?.commands.at(-1)).toBe(PATH_CLOSE)
			// The first vertex at the top centre; the outline fills its box.
			expect(vertices[0]?.[0]).toBeCloseTo((path?.w ?? 0) / 2, -0.3)
			expect(vertices[0]?.[1]).toBeCloseTo(0, -0.3)
			expect(Math.max(...vertices.map(([x]) => x)) - Math.min(...vertices.map(([x]) => x))).toBeCloseTo(path?.w ?? 0, -0.3)
			expect(Math.max(...vertices.map(([, y]) => y)) - Math.min(...vertices.map(([, y]) => y))).toBeCloseTo(path?.h ?? 0, -0.3)
		}

		// A square: four corners are a diamond.
		const diamond = shapes[1]?.props?.geometry

		if (diamond?.kind === "custom") {
			expect(points(diamond.paths[0]).map(([x, y]) => [Math.round(x), Math.round(y)])).toEqual([
				[50_000, 0],
				[100_000, 50_000],
				[50_000, 100_000],
				[0, 50_000]
			])
		}
	})

	it("reads a concave regular polygon as a star whose inner vertices draw:sharpness places", async () => {
		const [nine, half] = await shapesOf(
			'<draw:regular-polygon draw:corners="9" draw:concave="true" draw:sharpness="75%" svg:width="4cm" svg:height="4cm"/>' +
				'<draw:regular-polygon draw:corners="4" draw:concave="true" draw:sharpness="50%" svg:width="4cm" svg:height="4cm"/>'
		)
		const star = nine?.props?.geometry

		expect(star?.kind).toBe("custom")
		if (star?.kind !== "custom") return

		expect(points(star.paths[0])).toHaveLength(18)

		const square = half?.props?.geometry

		expect(square?.kind).toBe("custom")
		if (square?.kind !== "custom") return

		const vertices = points(square.paths[0])
		const [w, h] = [square.paths[0]?.w ?? 0, square.paths[0]?.h ?? 0]
		const radius = (x: number, y: number): number => Math.hypot(x - w / 2, y - h / 2)

		expect(vertices).toHaveLength(8)
		// Inner vertices at half the outer radius (sharpness 50%).
		expect(radius(...(vertices[1] ?? [0, 0])) / radius(...(vertices[0] ?? [0, 0]))).toBeCloseTo(0.5, 6)
	})

	it("jumps to a page whose name the href percent-encodes, from a listener and from a draw:a", async () => {
		const rect = '<draw:rect svg:width="1cm" svg:height="1cm"/>'
		const listener = (href: string): string =>
			`<draw:rect svg:width="1cm" svg:height="1cm"><office:event-listeners><presentation:event-listener script:event-name="dom:click" presentation:action="show" xlink:href="${href}" xlink:type="simple"/></office:event-listeners></draw:rect>`
		const opened = await openOdpFixture({
			body:
				'<draw:page draw:name="first" draw:master-page-name="M">' +
				listener("#50%25 growth") +
				`<draw:a xlink:href="#50%25 growth">${rect}</draw:a>` +
				listener("#50% growth") +
				`<draw:a xlink:href="#a%41">${rect}</draw:a>` +
				"</draw:page>" +
				'<draw:page draw:name="50% growth" draw:master-page-name="M"/>' +
				'<draw:page draw:name="a%41" draw:master-page-name="M"/>'
		})
		const shapes = (await slideOf(opened, 0)).shapes
		const target = { kind: "slide", slide: opened.deck.slides[1] }

		expect(shapes.map(shape => shape.actions?.click)).toEqual([target, target, target, { kind: "slide", slide: opened.deck.slides[2] }])
	})
})
