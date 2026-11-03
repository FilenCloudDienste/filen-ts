import { ItemKind, type DrawingList, type Rgba } from "../drawingml/displayList"
import { svgPath, type SubPath } from "../odt/geometry"

// OpenDocument 3D scenes (ODF 1.3 Part 3 §10.5: dr3d:scene with dr3d:cube, dr3d:sphere, dr3d:rotate, dr3d:extrude
// and nested scenes; the dr3d:* graphic properties of §20.8x) drawn as a mesh: each object tessellated, lit per
// vertex (ambient, the scene's directional lights, a specular highlight), projected through the scene's camera,
// sorted back to front and fitted to the scene's frame. The triangles go out as one Gouraud "shaded" paint over their
// own outline, so every painter rasterises them at the resolution it draws at.
//
// readScene takes the scene's XML once (at open); drawScene draws the plain data it returns into a drawing.

export type Vec3 = readonly [number, number, number]

export interface Dr3dLight {
	// 0xRRGGBB.
	readonly color: number
	// Towards the light, in view space.
	readonly direction: Vec3
	readonly specular: boolean
}

export interface Dr3dMaterial {
	// 0xRRGGBB.
	readonly diffuse: number
	readonly emissive: number
	readonly specular: number
	// Phong exponent.
	readonly shininess: number
	// 0..1.
	readonly alpha: number
	// draw:fill none: the object draws nothing.
	readonly visible: boolean
	readonly culling: boolean
	// dr3d:normals-kind: the geometry's own normals, one per face, or pointing away from the object's centre.
	readonly normals: "object" | "flat" | "sphere"
}

// Row-major 3x4: x' = m0 x + m1 y + m2 z + m3, and so on.
export type Matrix3d = readonly [number, number, number, number, number, number, number, number, number, number, number, number]

// A profile (rotate, extrude): closed or open polylines in the object's x/y plane.
export interface Dr3dProfile {
	// x, y pairs, every polyline after the other.
	readonly points: Float64Array
	// Start (in points) of each polyline; the last ends at points.length / 2.
	readonly starts: Int32Array
	readonly closed: Uint8Array
}

export type Dr3dObject = { readonly transform: Matrix3d; readonly material: Dr3dMaterial } & (
	| { readonly kind: "cube"; readonly min: Vec3; readonly max: Vec3 }
	| { readonly kind: "sphere"; readonly center: Vec3; readonly size: Vec3; readonly around: number; readonly along: number }
	| { readonly kind: "rotate"; readonly profile: Dr3dProfile; readonly around: number; readonly endAngle: number }
	| {
			readonly kind: "extrude"
			readonly profile: Dr3dProfile
			readonly depth: number
			readonly backScale: number
			readonly closeFront: boolean
			readonly closeBack: boolean
	  }
)

export interface Dr3dScene {
	readonly eye: Vec3
	readonly viewNormal: Vec3
	readonly up: Vec3
	readonly perspective: boolean
	// 0xRRGGBB.
	readonly ambient: number
	readonly lights: readonly Dr3dLight[]
	readonly smooth: boolean
	// The scene's own dr3d:transform; members' transforms are relative to it.
	readonly transform: Matrix3d
	readonly objects: readonly Dr3dObject[]
}

// Bounds on what one scene may cost: tessellation is clamped, and a scene past its triangle budget is refused.
export const DR3D_LIMITS = {
	objects: 4096,
	depth: 16,
	segments: 256,
	profilePoints: 20_000,
	triangles: 200_000
} as const

// The XML a scene is read from: an element tree and the graphic styles its members name.
export interface SceneSource {
	// The element's qualified name ("dr3d:cube").
	name(node: number): string
	attributes(node: number): ReadonlyMap<string, string>
	firstChild(node: number): number
	nextSibling(node: number): number
	// A graphic style's properties along its chain (`resolved`) and those its own element sets (`own`).
	style(name: string | undefined): { readonly resolved: ReadonlyMap<string, string>; readonly own: ReadonlyMap<string, string> }
}

// LibreOffice's default highlight is broad: its exponent (shininess × 128) is about 15.
const DEFAULT_SHININESS = 15 / 128
const IDENTITY_3D: Matrix3d = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
const DEFAULT_LIGHT: Dr3dLight = { color: 0xcccccc, direction: normalized([1, 1, 1]), specular: true }
const NUMBER = /-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/gu

function normalized(v: Vec3): Vec3 {
	const length = Math.hypot(v[0], v[1], v[2])

	return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1]
}

function cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function numbers(value: string | undefined): number[] {
	if (value === undefined) return []

	return (value.match(NUMBER) ?? []).map(Number).filter(Number.isFinite)
}

// "(x y z)" (§19.xx vector).
function vector(value: string | undefined, fallback: Vec3): Vec3 {
	const [x, y, z] = numbers(value)

	return x === undefined || y === undefined || z === undefined ? fallback : [x, y, z]
}

function color(value: string | undefined, fallback: number): number {
	return value !== undefined && /^#[0-9a-fA-F]{6}$/u.test(value) ? Number.parseInt(value.slice(1), 16) : fallback
}

function percent(value: string | undefined, fallback: number): number {
	const match = value === undefined ? null : /^\s*(-?\d+(?:\.\d*)?)%\s*$/u.exec(value)

	return match === null ? fallback : Number(match[1]) / 100
}

// An angle in degrees: degrees by default, else its unit.
function angle(value: string | undefined, fallback: number): number {
	const match = value === undefined ? null : /^\s*(-?\d+(?:\.\d*)?)\s*(deg|rad|grad)?\s*$/u.exec(value)

	if (match === null) return fallback

	const number = Number(match[1])

	return match[2] === "rad" ? (number * 180) / Math.PI : match[2] === "grad" ? number * 0.9 : number
}

// Lengths in the scene's unit (1/100 mm, LibreOffice's); a bare number is taken as written.
const PER_100TH_MM: Readonly<Record<string, number>> = { cm: 1000, mm: 100, in: 2540, pt: 2540 / 72, pc: 2540 / 6, px: 2540 / 96 }

function length(value: string | undefined, fallback: number): number {
	const match = value === undefined ? null : /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z]*)\s*$/u.exec(value)

	if (match === null) return fallback

	const scale = match[2] === "" ? 1 : PER_100TH_MM[match[2] ?? ""]

	return scale === undefined ? fallback : Number(match[1]) * scale
}

function multiply(a: Matrix3d, b: Matrix3d): Matrix3d {
	return [
		a[0] * b[0] + a[1] * b[4] + a[2] * b[8],
		a[0] * b[1] + a[1] * b[5] + a[2] * b[9],
		a[0] * b[2] + a[1] * b[6] + a[2] * b[10],
		a[0] * b[3] + a[1] * b[7] + a[2] * b[11] + a[3],
		a[4] * b[0] + a[5] * b[4] + a[6] * b[8],
		a[4] * b[1] + a[5] * b[5] + a[6] * b[9],
		a[4] * b[2] + a[5] * b[6] + a[6] * b[10],
		a[4] * b[3] + a[5] * b[7] + a[6] * b[11] + a[7],
		a[8] * b[0] + a[9] * b[4] + a[10] * b[8],
		a[8] * b[1] + a[9] * b[5] + a[10] * b[9],
		a[8] * b[2] + a[9] * b[6] + a[10] * b[10],
		a[8] * b[3] + a[9] * b[7] + a[10] * b[11] + a[11]
	]
}

// dr3d:transform (§19.xx): matrix, rotatex/y/z, scale and translate, applied left to right as SVG transforms are.
// matrix(a … l) lists the columns of the 3x3 part, then the translation.
export function transform3d(value: string | undefined): Matrix3d {
	if (value === undefined) return IDENTITY_3D

	let out: Matrix3d = IDENTITY_3D

	for (const match of value.matchAll(/(matrix|rotatex|rotatey|rotatez|scale|translate)\s*\(([^)]*)\)/gu)) {
		const name = match[1]
		const args = (match[2] ?? "").trim().split(/[\s,]+/u)
		let step: Matrix3d | undefined

		if (name === "matrix" && args.length >= 12) {
			const [a, b, c, d, e, f, g, h, i] = args.slice(0, 9).map(Number)
			const tx = length(args[9], 0)
			const ty = length(args[10], 0)
			const tz = length(args[11], 0)

			if ([a, b, c, d, e, f, g, h, i].every(n => n !== undefined && Number.isFinite(n)))
				step = [a ?? 1, d ?? 0, g ?? 0, tx, b ?? 0, e ?? 1, h ?? 0, ty, c ?? 0, f ?? 0, i ?? 1, tz]
		} else if (name === "rotatex" || name === "rotatey" || name === "rotatez") {
			const radians = (angle(args[0], 0) * Math.PI) / 180
			const cos = Math.cos(radians)
			const sin = Math.sin(radians)

			step =
				name === "rotatex"
					? [1, 0, 0, 0, 0, cos, -sin, 0, 0, sin, cos, 0]
					: name === "rotatey"
						? [cos, 0, sin, 0, 0, 1, 0, 0, -sin, 0, cos, 0]
						: [cos, -sin, 0, 0, sin, cos, 0, 0, 0, 0, 1, 0]
		} else if (name === "scale") {
			const [x = 1, y = x, z = 1] = args.map(Number).filter(Number.isFinite)

			step = [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]
		} else if (name === "translate") {
			step = [1, 0, 0, length(args[0], 0), 0, 1, 0, length(args[1], 0), 0, 0, 1, length(args[2], 0)]
		}

		if (step !== undefined) out = multiply(out, step)
	}

	return out
}

// A polyline set from svg:d, curves flattened.
const CURVE_STEPS = 8

function profileOf(data: string | undefined): Dr3dProfile | undefined {
	if (data === undefined) return undefined

	let paths: SubPath[]

	try {
		paths = svgPath(data)
	} catch {
		return undefined
	}

	const points: number[] = []
	const starts: number[] = []
	const closed: number[] = []

	for (const path of paths) {
		let x = 0
		let y = 0
		let start = -1

		const push = (px: number, py: number): void => {
			if (start < 0) {
				start = points.length / 2
				starts.push(start)
				closed.push(0)
			}

			points.push(px, py)
			x = px
			y = py
		}

		for (const segment of path.segments) {
			if (points.length / 2 > DR3D_LIMITS.profilePoints) return undefined

			if (segment.kind === "M") {
				start = -1
				push(segment.x, segment.y)
			} else if (segment.kind === "L") {
				if (start < 0) push(x, y)

				push(segment.x, segment.y)
			} else if (segment.kind === "C") {
				if (start < 0) push(x, y)

				const x0 = x
				const y0 = y

				for (let k = 1; k <= CURVE_STEPS; k++) {
					const t = k / CURVE_STEPS
					const u = 1 - t

					push(
						u * u * u * x0 + 3 * u * u * t * segment.x1 + 3 * u * t * t * segment.x2 + t * t * t * segment.x,
						u * u * u * y0 + 3 * u * u * t * segment.y1 + 3 * u * t * t * segment.y2 + t * t * t * segment.y
					)
				}
			} else if (start >= 0) {
				closed[closed.length - 1] = 1
				start = -1
			}
		}
	}

	if (starts.length === 0) return undefined

	return { points: Float64Array.from(points), starts: Int32Array.from(starts), closed: Uint8Array.from(closed) }
}

type Lookup = (name: string) => string | undefined

function materialOf(get: Lookup): Dr3dMaterial {
	const fill = get("draw:fill")

	return {
		diffuse: color(get("draw:fill-color"), 0x729fcf),
		emissive: color(get("dr3d:emissive-color"), 0x000000),
		specular: color(get("dr3d:specular-color"), 0xffffff),
		shininess: Math.max(1, percent(get("dr3d:shininess"), DEFAULT_SHININESS) * 128),
		alpha: Math.min(1, Math.max(0, percent(get("draw:opacity"), 1) * (1 - percent(get("draw:transparency"), 0)))),
		visible: fill !== "none",
		culling: get("dr3d:backface-culling") === "enabled",
		normals: normalsKind(get("dr3d:normals-kind"))
	}
}

function normalsKind(value: string | undefined): Dr3dMaterial["normals"] {
	return value === "flat" || value === "sphere" ? value : "object"
}

function segments(value: string | undefined, fallback: number): number {
	const n = Math.round(Number(value))

	return Number.isFinite(n) && n > 0 ? Math.min(DR3D_LIMITS.segments, Math.max(2, n)) : fallback
}

interface ReadState {
	objects: Dr3dObject[]
}

function readMembers(source: SceneSource, node: number, inherited: Lookup, matrix: Matrix3d, depth: number, state: ReadState): void {
	for (let child = source.firstChild(node); child >= 0; child = source.nextSibling(child)) {
		const name = source.name(child)

		if (!name.startsWith("dr3d:") || name === "dr3d:light") continue
		if (state.objects.length >= DR3D_LIMITS.objects) return

		const attributes = source.attributes(child)
		const style = source.style(attributes.get("draw:style-name"))
		// LibreOffice hands a scene's attributes to its members: a member's own style overrides them, its parents do not.
		const get: Lookup = key => style.own.get(key) ?? inherited(key) ?? style.resolved.get(key)
		const transform = multiply(matrix, transform3d(attributes.get("dr3d:transform")))

		if (name === "dr3d:scene") {
			if (depth < DR3D_LIMITS.depth) readMembers(source, child, get, transform, depth + 1, state)

			continue
		}

		const material = materialOf(get)
		const around = segments(get("dr3d:horizontal-segments"), 24)
		const along = segments(get("dr3d:vertical-segments"), 24)

		switch (name) {
			case "dr3d:cube":
				state.objects.push({
					kind: "cube",
					transform,
					material,
					min: vector(attributes.get("dr3d:min-edge"), [-2500, -2500, -2500]),
					max: vector(attributes.get("dr3d:max-edge"), [2500, 2500, 2500])
				})
				break
			case "dr3d:sphere":
				state.objects.push({
					kind: "sphere",
					transform,
					material,
					center: vector(attributes.get("dr3d:center"), [0, 0, 0]),
					size: vector(attributes.get("dr3d:size"), [5000, 5000, 5000]),
					around,
					along
				})
				break
			case "dr3d:rotate": {
				const profile = profileOf(attributes.get("svg:d"))

				if (profile !== undefined)
					state.objects.push({
						kind: "rotate",
						transform,
						material,
						profile,
						around,
						endAngle: angle(get("dr3d:end-angle"), 360)
					})

				break
			}
			case "dr3d:extrude": {
				const profile = profileOf(attributes.get("svg:d"))

				if (profile !== undefined)
					state.objects.push({
						kind: "extrude",
						transform,
						material,
						profile,
						depth: length(get("dr3d:depth"), 1000),
						backScale: percent(get("dr3d:back-scale"), 1),
						closeFront: get("dr3d:close-front") !== "false",
						closeBack: get("dr3d:close-back") !== "false"
					})

				break
			}
			default:
				break
		}
	}
}

// The scene at `node` (a dr3d:scene element) as plain data; undefined when it holds nothing to draw.
export function readScene(source: SceneSource, node: number): Dr3dScene | undefined {
	const attributes = source.attributes(node)
	const style = source.style(attributes.get("draw:style-name"))
	const get: Lookup = key => style.resolved.get(key)
	const lights: Dr3dLight[] = []

	for (let child = source.firstChild(node); child >= 0; child = source.nextSibling(child)) {
		if (source.name(child) !== "dr3d:light") continue

		const light = source.attributes(child)

		if (light.get("dr3d:enabled") === "false") continue

		lights.push({
			color: color(light.get("dr3d:diffuse-color"), 0xcccccc),
			direction: normalized(vector(light.get("dr3d:direction"), [0, 0, 1])),
			specular: light.get("dr3d:specular") === "true"
		})
	}

	const state: ReadState = { objects: [] }

	readMembers(source, node, get, IDENTITY_3D, 1, state)

	if (state.objects.length === 0) return undefined

	const shade = attributes.get("dr3d:shade-mode") ?? get("dr3d:shade-mode")

	return {
		eye: vector(attributes.get("dr3d:vrp"), [0, 0, 16885.7142857143]),
		viewNormal: normalized(vector(attributes.get("dr3d:vpn"), [0, 0, 1])),
		up: normalized(vector(attributes.get("dr3d:vup"), [0, 1, 0])),
		perspective: (attributes.get("dr3d:projection") ?? get("dr3d:projection")) !== "parallel",
		ambient: color(attributes.get("dr3d:ambient-color") ?? get("dr3d:ambient-color"), 0x666666),
		lights: lights.length > 0 || attributes.has("dr3d:lighting-mode") ? lights : [DEFAULT_LIGHT],
		smooth: shade !== "flat" && shade !== "draft",
		transform: transform3d(attributes.get("dr3d:transform")),
		objects: state.objects
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing

class TooManyTriangles extends Error {}

// Triangles in view space: per vertex position and normal, then the object's material.
class Mesh {
	positions = new Float64Array(9 * 64)
	normals = new Float64Array(9 * 64)
	materials: Dr3dMaterial[] = []
	// Per triangle: whether it belongs to a closed solid (its faces turned away from the eye are hidden).
	solids: boolean[] = []
	solid = false
	count = 0

	add(
		material: Dr3dMaterial,
		ax: number,
		ay: number,
		az: number,
		bx: number,
		by: number,
		bz: number,
		cx: number,
		cy: number,
		cz: number,
		na: Vec3,
		nb: Vec3,
		nc: Vec3
	): void {
		if (this.count >= DR3D_LIMITS.triangles) throw new TooManyTriangles()

		if (this.count * 9 + 9 > this.positions.length) {
			const size = this.positions.length * 2
			const positions = new Float64Array(size)
			const normals = new Float64Array(size)

			positions.set(this.positions)
			normals.set(this.normals)
			this.positions = positions
			this.normals = normals
		}

		const at = this.count * 9
		const p = this.positions
		const n = this.normals

		p[at] = ax
		p[at + 1] = ay
		p[at + 2] = az
		p[at + 3] = bx
		p[at + 4] = by
		p[at + 5] = bz
		p[at + 6] = cx
		p[at + 7] = cy
		p[at + 8] = cz
		n[at] = na[0]
		n[at + 1] = na[1]
		n[at + 2] = na[2]
		n[at + 3] = nb[0]
		n[at + 4] = nb[1]
		n[at + 5] = nb[2]
		n[at + 6] = nc[0]
		n[at + 7] = nc[1]
		n[at + 8] = nc[2]
		this.materials.push(material)
		this.solids.push(this.solid)
		this.count++
	}
}

// An object's vertices into view space: its own transform, then the camera's.
class Placement {
	private readonly m: Matrix3d
	// The inverse transpose of the 3x3 part, for normals.
	private readonly n: readonly number[]

	// The object's centre when its normals point away from it (normals-kind sphere).
	private readonly centre: Vec3 | undefined

	constructor(view: Matrix3d, object: Matrix3d, centre?: Vec3) {
		const m = multiply(view, object)

		this.centre = centre

		this.m = m

		const [a, b, c, , d, e, f, , g, h, i] = m
		const A = e * i - f * h
		const B = -(d * i - f * g)
		const C = d * h - e * g
		const det = a * A + b * B + c * C
		const s = Math.abs(det) > 1e-12 ? 1 / det : 0

		// (M^-1)^T = cofactor matrix / det.
		this.n = [
			A * s,
			B * s,
			C * s,
			-(b * i - c * h) * s,
			(a * i - c * g) * s,
			-(a * h - b * g) * s,
			(b * f - c * e) * s,
			-(a * f - c * d) * s,
			(a * e - b * d) * s
		]
	}

	point(x: number, y: number, z: number): Vec3 {
		const m = this.m

		return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]]
	}

	// The normal at object point (x, y, z) whose geometry's own normal is (nx, ny, nz).
	normalAt(x: number, y: number, z: number, nx: number, ny: number, nz: number): Vec3 {
		const centre = this.centre

		return centre === undefined ? this.normal(nx, ny, nz) : this.normal(x - centre[0], y - centre[1], z - centre[2])
	}

	normal(x: number, y: number, z: number): Vec3 {
		const n = this.n

		return normalized([
			(n[0] ?? 0) * x + (n[1] ?? 0) * y + (n[2] ?? 0) * z,
			(n[3] ?? 0) * x + (n[4] ?? 0) * y + (n[5] ?? 0) * z,
			(n[6] ?? 0) * x + (n[7] ?? 0) * y + (n[8] ?? 0) * z
		])
	}
}

function quad(mesh: Mesh, material: Dr3dMaterial, a: Vec3, b: Vec3, c: Vec3, d: Vec3, na: Vec3, nb: Vec3, nc: Vec3, nd: Vec3): void {
	mesh.add(material, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], na, nb, nc)
	mesh.add(material, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], na, nc, nd)
}

function cube(mesh: Mesh, place: Placement, object: Extract<Dr3dObject, { kind: "cube" }>): void {
	const [x0, y0, z0] = object.min
	const [x1, y1, z1] = object.max
	const at = (i: number): Vec3 => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0]
	const c = [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
		const [x, y, z] = at(i)

		return place.point(x, y, z)
	})
	// Each face counter-clockwise seen from outside, with its outward normal.
	const faces: readonly (readonly [number, number, number, number, Vec3])[] = [
		[4, 5, 7, 6, [0, 0, 1]],
		[1, 0, 2, 3, [0, 0, -1]],
		[5, 1, 3, 7, [1, 0, 0]],
		[0, 4, 6, 2, [-1, 0, 0]],
		[6, 7, 3, 2, [0, 1, 0]],
		[0, 1, 5, 4, [0, -1, 0]]
	]

	for (const [a, b, cc, d, normal] of faces) {
		const n = (i: number): Vec3 => {
			const [x, y, z] = at(i)

			return place.normalAt(x, y, z, normal[0], normal[1], normal[2])
		}

		quad(mesh, object.material, c[a] ?? [0, 0, 0], c[b] ?? [0, 0, 0], c[cc] ?? [0, 0, 0], c[d] ?? [0, 0, 0], n(a), n(b), n(cc), n(d))
	}
}

function sphere(mesh: Mesh, place: Placement, object: Extract<Dr3dObject, { kind: "sphere" }>): void {
	const [cx, cy, cz] = object.center
	const rx = object.size[0] / 2
	const ry = object.size[1] / 2
	const rz = object.size[2] / 2
	const around = object.around
	const along = object.along
	const point = (i: number, j: number): [Vec3, Vec3] => {
		const theta = (j / along) * Math.PI
		const phi = (i / around) * 2 * Math.PI
		const sx = Math.sin(theta) * Math.cos(phi)
		const sy = Math.cos(theta)
		const sz = Math.sin(theta) * Math.sin(phi)

		const x = cx + rx * sx
		const y = cy + ry * sy
		const z = cz + rz * sz

		return [place.point(x, y, z), place.normalAt(x, y, z, sx / (rx || 1), sy / (ry || 1), sz / (rz || 1))]
	}

	for (let j = 0; j < along; j++) {
		for (let i = 0; i < around; i++) {
			const [a, na] = point(i, j)
			const [b, nb] = point(i, j + 1)
			const [c, nc] = point(i + 1, j + 1)
			const [d, nd] = point(i + 1, j)

			if (j > 0) mesh.add(object.material, a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2], na, nb, nd)
			if (j < along - 1) mesh.add(object.material, b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], nb, nc, nd)
		}
	}
}

// Per polyline point, the profile normal (x, y) on each side of it: smooth where the outline turns by less than 45°.
const CREASE = Math.cos(Math.PI / 4)

function profileNormals(profile: Dr3dProfile, polyline: number, outward: number): { before: Float64Array; after: Float64Array } {
	const points = profile.points
	const start = profile.starts[polyline] ?? 0
	const end = polyline + 1 < profile.starts.length ? (profile.starts[polyline + 1] ?? 0) : points.length / 2
	const count = end - start
	const closed = profile.closed[polyline] === 1
	const segment = new Float64Array(count * 2)

	for (let k = 0; k < count; k++) {
		const next = k + 1 < count ? k + 1 : closed ? 0 : k
		const dx = (points[(start + next) * 2] ?? 0) - (points[(start + k) * 2] ?? 0)
		const dy = (points[(start + next) * 2 + 1] ?? 0) - (points[(start + k) * 2 + 1] ?? 0)
		const length = Math.hypot(dx, dy)

		segment[k * 2] = length > 0 ? (outward * dy) / length : 0
		segment[k * 2 + 1] = length > 0 ? (-outward * dx) / length : 0
	}

	const before = new Float64Array(count * 2)
	const after = new Float64Array(count * 2)

	for (let k = 0; k < count; k++) {
		const previous = k > 0 ? k - 1 : closed ? count - 1 : k
		const ax = segment[previous * 2] ?? 0
		const ay = segment[previous * 2 + 1] ?? 0
		const bx = segment[k * 2] ?? 0
		const by = segment[k * 2 + 1] ?? 0

		if (ax * bx + ay * by >= CREASE) {
			const length = Math.hypot(ax + bx, ay + by) || 1

			before[k * 2] = after[k * 2] = (ax + bx) / length
			before[k * 2 + 1] = after[k * 2 + 1] = (ay + by) / length
		} else {
			before[k * 2] = ax
			before[k * 2 + 1] = ay
			after[k * 2] = bx
			after[k * 2 + 1] = by
		}
	}

	return { before, after }
}

// The sign that turns a polyline's left-hand normal outward: away from the axis (rotate) or from its inside
// (closed outlines, by their winding).
// Whether a polyline starts and ends on the rotation axis (a profile LibreOffice leaves open there).
function onAxis(profile: Dr3dProfile, polyline: number): boolean {
	const points = profile.points
	const start = profile.starts[polyline] ?? 0
	const end = polyline + 1 < profile.starts.length ? (profile.starts[polyline + 1] ?? 0) : points.length / 2

	return end - start >= 2 && Math.abs(points[start * 2] ?? 1) < 1e-6 && Math.abs(points[(end - 1) * 2] ?? 1) < 1e-6
}

// Whether an object is closed, so its far side never shows.
function solidOf(object: Dr3dObject): boolean {
	switch (object.kind) {
		case "cube":
		case "sphere":
			return true
		case "rotate": {
			if (object.endAngle < 360) return false

			for (let polyline = 0; polyline < object.profile.starts.length; polyline++)
				if (object.profile.closed[polyline] !== 1 && !onAxis(object.profile, polyline)) return false

			return true
		}
		case "extrude":
			return object.closeFront && object.closeBack && object.profile.closed.every(closed => closed === 1)
	}
}

function outwardSign(profile: Dr3dProfile, polyline: number, axis: boolean): number {
	const points = profile.points
	const start = profile.starts[polyline] ?? 0
	const end = polyline + 1 < profile.starts.length ? (profile.starts[polyline + 1] ?? 0) : points.length / 2
	let area = 0
	let x = 0

	for (let k = start; k < end; k++) {
		const next = k + 1 < end ? k + 1 : start

		area += (points[k * 2] ?? 0) * (points[next * 2 + 1] ?? 0) - (points[next * 2] ?? 0) * (points[k * 2 + 1] ?? 0)
		x += points[k * 2] ?? 0
	}

	if ((profile.closed[polyline] === 1 || onAxis(profile, polyline)) && area !== 0) return area > 0 ? 1 : -1

	// An open outline: the side its first segment's normal points to, turned away from the axis.
	const dy = (points[(start + 1) * 2 + 1] ?? 0) - (points[start * 2 + 1] ?? 0)

	return axis ? (dy * (x >= 0 ? 1 : -1) >= 0 ? 1 : -1) : dy >= 0 ? 1 : -1
}

function rotate(mesh: Mesh, place: Placement, object: Extract<Dr3dObject, { kind: "rotate" }>): void {
	const profile = object.profile
	const points = profile.points
	const sweep = (Math.min(360, Math.max(0, object.endAngle)) * Math.PI) / 180
	const steps = Math.max(2, Math.round(object.around * (sweep / (2 * Math.PI))))

	for (let polyline = 0; polyline < profile.starts.length; polyline++) {
		const start = profile.starts[polyline] ?? 0
		const end = polyline + 1 < profile.starts.length ? (profile.starts[polyline + 1] ?? 0) : points.length / 2
		const count = end - start
		const closed = profile.closed[polyline] === 1
		const normals = profileNormals(profile, polyline, outwardSign(profile, polyline, true))
		const segmentCount = closed ? count : count - 1
		const turned = (x: number, y: number, step: number): Vec3 => {
			const a = (step / steps) * sweep

			return place.point(x * Math.cos(a), y, -x * Math.sin(a))
		}
		const turnedNormal = (x: number, y: number, nx: number, ny: number, step: number): Vec3 => {
			const a = (step / steps) * sweep
			const cos = Math.cos(a)
			const sin = Math.sin(a)

			return place.normalAt(x * cos, y, -x * sin, nx * cos, ny, -nx * sin)
		}

		for (let k = 0; k < segmentCount; k++) {
			const next = k + 1 < count ? k + 1 : 0
			const x0 = points[(start + k) * 2] ?? 0
			const y0 = points[(start + k) * 2 + 1] ?? 0
			const x1 = points[(start + next) * 2] ?? 0
			const y1 = points[(start + next) * 2 + 1] ?? 0
			const n0x = normals.after[k * 2] ?? 0
			const n0y = normals.after[k * 2 + 1] ?? 0
			const n1x = normals.before[next * 2] ?? 0
			const n1y = normals.before[next * 2 + 1] ?? 0

			for (let step = 0; step < steps; step++) {
				const a = turned(x0, y0, step)
				const b = turned(x1, y1, step)
				const c = turned(x1, y1, step + 1)
				const d = turned(x0, y0, step + 1)

				quad(
					mesh,
					object.material,
					a,
					b,
					c,
					d,
					turnedNormal(x0, y0, n0x, n0y, step),
					turnedNormal(x1, y1, n1x, n1y, step),
					turnedNormal(x1, y1, n1x, n1y, step + 1),
					turnedNormal(x0, y0, n0x, n0y, step + 1)
				)
			}
		}
	}
}

// Ear clipping of one simple polygon (x, y pairs) into triangles of point indices.
function triangulate(points: Float64Array, start: number, count: number): number[] {
	const out: number[] = []
	const index: number[] = []
	let area = 0

	for (let k = 0; k < count; k++) {
		const next = (k + 1) % count

		area +=
			(points[(start + k) * 2] ?? 0) * (points[(start + next) * 2 + 1] ?? 0) -
			(points[(start + next) * 2] ?? 0) * (points[(start + k) * 2 + 1] ?? 0)
		index.push(start + k)
	}

	if (area < 0) index.reverse()

	const x = (i: number): number => points[i * 2] ?? 0
	const y = (i: number): number => points[i * 2 + 1] ?? 0
	let guard = count * count

	while (index.length > 3 && guard-- > 0) {
		let clipped = false

		for (let k = 0; k < index.length; k++) {
			const a = index[(k + index.length - 1) % index.length] ?? 0
			const b = index[k] ?? 0
			const c = index[(k + 1) % index.length] ?? 0
			const turn = (x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a))

			if (turn <= 0) continue

			let inside = false

			for (const p of index) {
				if (p === a || p === b || p === c) continue

				const d1 = (x(b) - x(a)) * (y(p) - y(a)) - (y(b) - y(a)) * (x(p) - x(a))
				const d2 = (x(c) - x(b)) * (y(p) - y(b)) - (y(c) - y(b)) * (x(p) - x(b))
				const d3 = (x(a) - x(c)) * (y(p) - y(c)) - (y(a) - y(c)) * (x(p) - x(c))

				if (d1 >= 0 && d2 >= 0 && d3 >= 0) {
					inside = true
					break
				}
			}

			if (inside) continue

			out.push(a, b, c)
			index.splice(k, 1)
			clipped = true
			break
		}

		if (!clipped) break
	}

	if (index.length === 3) out.push(index[0] ?? 0, index[1] ?? 0, index[2] ?? 0)

	return out
}

function extrude(mesh: Mesh, place: Placement, object: Extract<Dr3dObject, { kind: "extrude" }>): void {
	const profile = object.profile
	const points = profile.points
	const front = 0
	const back = -object.depth
	// The back face scaled about the outline's centre.
	let cx = 0
	let cy = 0

	for (let k = 0; k < points.length; k += 2) {
		cx += points[k] ?? 0
		cy += points[k + 1] ?? 0
	}

	cx /= Math.max(1, points.length / 2)
	cy /= Math.max(1, points.length / 2)

	const backPoint = (k: number): Vec3 =>
		place.point(cx + ((points[k * 2] ?? 0) - cx) * object.backScale, cy + ((points[k * 2 + 1] ?? 0) - cy) * object.backScale, back)
	const frontPoint = (k: number): Vec3 => place.point(points[k * 2] ?? 0, points[k * 2 + 1] ?? 0, front)

	for (let polyline = 0; polyline < profile.starts.length; polyline++) {
		const start = profile.starts[polyline] ?? 0
		const end = polyline + 1 < profile.starts.length ? (profile.starts[polyline + 1] ?? 0) : points.length / 2
		const count = end - start
		const closed = profile.closed[polyline] === 1
		const normals = profileNormals(profile, polyline, outwardSign(profile, polyline, false))
		const segmentCount = closed ? count : count - 1

		for (let k = 0; k < segmentCount; k++) {
			const next = k + 1 < count ? k + 1 : 0
			const ax = points[(start + k) * 2] ?? 0
			const ay = points[(start + k) * 2 + 1] ?? 0
			const bx = points[(start + next) * 2] ?? 0
			const by = points[(start + next) * 2 + 1] ?? 0
			const n0x = normals.after[k * 2] ?? 0
			const n0y = normals.after[k * 2 + 1] ?? 0
			const n1x = normals.before[next * 2] ?? 0
			const n1y = normals.before[next * 2 + 1] ?? 0

			quad(
				mesh,
				object.material,
				frontPoint(start + k),
				frontPoint(start + next),
				backPoint(start + next),
				backPoint(start + k),
				place.normalAt(ax, ay, front, n0x, n0y, 0),
				place.normalAt(bx, by, front, n1x, n1y, 0),
				place.normalAt(bx, by, back, n1x, n1y, 0),
				place.normalAt(ax, ay, back, n0x, n0y, 0)
			)
		}

		if (!closed || count < 3) continue

		const caps = triangulate(points, start, count)
		const capNormal = (k: number, z: number): Vec3 =>
			place.normalAt(points[k * 2] ?? 0, points[k * 2 + 1] ?? 0, z, 0, 0, z === front ? 1 : -1)

		for (let k = 0; k + 2 < caps.length; k += 3) {
			const a = caps[k] ?? 0
			const b = caps[k + 1] ?? 0
			const c = caps[k + 2] ?? 0

			if (object.closeFront) {
				const [pa, pb, pc] = [frontPoint(a), frontPoint(b), frontPoint(c)]

				mesh.add(
					object.material,
					pa[0],
					pa[1],
					pa[2],
					pb[0],
					pb[1],
					pb[2],
					pc[0],
					pc[1],
					pc[2],
					capNormal(a, front),
					capNormal(b, front),
					capNormal(c, front)
				)
			}

			if (object.closeBack) {
				const [pa, pb, pc] = [backPoint(a), backPoint(c), backPoint(b)]

				mesh.add(
					object.material,
					pa[0],
					pa[1],
					pa[2],
					pb[0],
					pb[1],
					pb[2],
					pc[0],
					pc[1],
					pc[2],
					capNormal(a, back),
					capNormal(c, back),
					capNormal(b, back)
				)
			}
		}
	}
}

// An object's own bounds: min x, y, z, then max.
function boundsOf(object: Dr3dObject): readonly [number, number, number, number, number, number] {
	switch (object.kind) {
		case "cube":
			return [
				Math.min(object.min[0], object.max[0]),
				Math.min(object.min[1], object.max[1]),
				Math.min(object.min[2], object.max[2]),
				Math.max(object.min[0], object.max[0]),
				Math.max(object.min[1], object.max[1]),
				Math.max(object.min[2], object.max[2])
			]
		case "sphere": {
			const [cx, cy, cz] = object.center
			const [w, h, d] = object.size.map(n => Math.abs(n) / 2)

			return [cx - (w ?? 0), cy - (h ?? 0), cz - (d ?? 0), cx + (w ?? 0), cy + (h ?? 0), cz + (d ?? 0)]
		}
		case "rotate":
		case "extrude": {
			const points = object.profile.points
			let minX = Number.POSITIVE_INFINITY
			let minY = Number.POSITIVE_INFINITY
			let maxX = Number.NEGATIVE_INFINITY
			let maxY = Number.NEGATIVE_INFINITY

			for (let k = 0; k + 1 < points.length; k += 2) {
				const x = points[k] ?? 0
				const y = points[k + 1] ?? 0

				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
			}

			if (object.kind === "extrude") return [minX, minY, -object.depth, maxX, maxY, 0]

			const radius = Math.max(Math.abs(minX), Math.abs(maxX))

			return [-radius, minY, -radius, radius, maxY, radius]
		}
	}
}

function corners(box: readonly number[]): Vec3[] {
	const out: Vec3[] = []

	for (let i = 0; i < 8; i++) out.push([box[i & 1 ? 3 : 0] ?? 0, box[i & 2 ? 4 : 1] ?? 0, box[i & 4 ? 5 : 2] ?? 0])

	return out
}

// The projected bounds (min x, min y, max x, max y) of the scene's bounding box; undefined when a corner lies behind
// the eye.
function sceneBounds(scene: Dr3dScene, view: Matrix3d): [number, number, number, number] | undefined {
	const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]

	for (const object of scene.objects) {
		if (!object.material.visible) continue

		const m = object.transform

		for (const [x, y, z] of corners(boundsOf(object))) {
			const point = [
				m[0] * x + m[1] * y + m[2] * z + m[3],
				m[4] * x + m[5] * y + m[6] * z + m[7],
				m[8] * x + m[9] * y + m[10] * z + m[11]
			]

			for (let k = 0; k < 3; k++) {
				box[k] = Math.min(box[k] ?? 0, point[k] ?? 0)
				box[k + 3] = Math.max(box[k + 3] ?? 0, point[k] ?? 0)
			}
		}
	}

	if (!(box[0] !== undefined && Number.isFinite(box[0]))) return undefined

	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (const [x, y, z] of corners(box)) {
		const vx = view[0] * x + view[1] * y + view[2] * z + view[3]
		const vy = view[4] * x + view[5] * y + view[6] * z + view[7]
		const vz = view[8] * x + view[9] * y + view[10] * z + view[11]

		if (scene.perspective && vz >= -1e-6) return undefined

		const scale = scene.perspective ? 1 / -vz : 1
		const px = vx * scale
		const py = -vy * scale

		minX = Math.min(minX, px)
		minY = Math.min(minY, py)
		maxX = Math.max(maxX, px)
		maxY = Math.max(maxY, py)
	}

	return [minX, minY, maxX, maxY]
}

// The middle of an object's own bounds.
function centreOf(object: Dr3dObject): Vec3 {
	switch (object.kind) {
		case "cube":
			return [(object.min[0] + object.max[0]) / 2, (object.min[1] + object.max[1]) / 2, (object.min[2] + object.max[2]) / 2]
		case "sphere":
			return object.center
		case "rotate":
		case "extrude": {
			const points = object.profile.points
			let minX = Number.POSITIVE_INFINITY
			let minY = Number.POSITIVE_INFINITY
			let maxX = Number.NEGATIVE_INFINITY
			let maxY = Number.NEGATIVE_INFINITY

			for (let k = 0; k + 1 < points.length; k += 2) {
				const x = points[k] ?? 0
				const y = points[k + 1] ?? 0

				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
			}

			const midY = (minY + maxY) / 2

			return object.kind === "rotate" ? [0, midY, 0] : [(minX + maxX) / 2, midY, -object.depth / 2]
		}
	}
}

// The camera: view space has the eye at the origin looking down -z, y up.
function viewMatrix(scene: Dr3dScene): Matrix3d {
	const z = scene.viewNormal
	let x = cross(scene.up, z)

	if (Math.hypot(x[0], x[1], x[2]) < 1e-9) x = cross([1, 0, 0], z)

	x = normalized(x)

	const y = cross(z, x)
	const [ex, ey, ez] = scene.eye

	return [
		x[0],
		x[1],
		x[2],
		-(x[0] * ex + x[1] * ey + x[2] * ez),
		y[0],
		y[1],
		y[2],
		-(y[0] * ex + y[1] * ey + y[2] * ez),
		z[0],
		z[1],
		z[2],
		-(z[0] * ex + z[1] * ey + z[2] * ez)
	]
}

function channel(value: number, shift: number): number {
	return ((value >>> shift) & 255) / 255
}

// The colour at a vertex: emission, ambient and each light's diffuse share of the material, plus its highlight.
function lit(scene: Dr3dScene, material: Dr3dMaterial, px: number, py: number, pz: number, normal: Vec3, out: Float64Array): void {
	let [nx, ny, nz] = normal
	// The direction to the eye.
	let vx = scene.perspective ? -px : 0
	let vy = scene.perspective ? -py : 0
	let vz = scene.perspective ? -pz : 1
	const vl = Math.hypot(vx, vy, vz) || 1

	vx /= vl
	vy /= vl
	vz /= vl

	// Lit on the side that faces the eye.
	if (nx * vx + ny * vy + nz * vz < 0) {
		nx = -nx
		ny = -ny
		nz = -nz
	}

	const dr = channel(material.diffuse, 16)
	const dg = channel(material.diffuse, 8)
	const db = channel(material.diffuse, 0)
	let r = channel(material.emissive, 16) + channel(scene.ambient, 16) * dr
	let g = channel(material.emissive, 8) + channel(scene.ambient, 8) * dg
	let b = channel(material.emissive, 0) + channel(scene.ambient, 0) * db

	for (const light of scene.lights) {
		const [lx, ly, lz] = light.direction
		const diffuse = nx * lx + ny * ly + nz * lz

		if (diffuse <= 0) continue

		r += channel(light.color, 16) * dr * diffuse
		g += channel(light.color, 8) * dg * diffuse
		b += channel(light.color, 0) * db * diffuse

		if (!light.specular) continue

		const hx = lx + vx
		const hy = ly + vy
		const hz = lz + vz
		const hl = Math.hypot(hx, hy, hz) || 1
		const highlight = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), material.shininess)

		r += channel(material.specular, 16) * highlight
		g += channel(material.specular, 8) * highlight
		b += channel(material.specular, 0) * highlight
	}

	out[0] = Math.min(1, r)
	out[1] = Math.min(1, g)
	out[2] = Math.min(1, b)
}

function packed(r: number, g: number, b: number, alpha: number): Rgba {
	return ((Math.round(r * 255) << 24) | (Math.round(g * 255) << 16) | (Math.round(b * 255) << 8) | Math.round(alpha * 255)) >>> 0
}

// Draws `scene` into `list` through `matrix` (the frame's px to the list's), fitted to `width` x `height` px. False
// when it draws nothing (no visible triangle) or is over its triangle budget.
// The scene's mesh fitted to `width` x `height` px: per triangle its corners (counter-clockwise on screen) and their
// colours; undefined when no triangle shows or the scene is over its triangle budget.
function meshOf(scene: Dr3dScene, width: number, height: number): SceneMesh | undefined {
	const mesh = new Mesh()
	const view = multiply(viewMatrix(scene), scene.transform)

	try {
		for (const object of scene.objects) {
			if (!object.material.visible) continue

			// A cube's own normals point away from its centre (its faces shade like a rounded box).
			const radial = object.material.normals === "sphere" || (object.kind === "cube" && object.material.normals === "object")
			const place = new Placement(view, object.transform, radial ? centreOf(object) : undefined)

			mesh.solid = solidOf(object)

			if (object.kind === "cube") cube(mesh, place, object)
			else if (object.kind === "sphere") sphere(mesh, place, object)
			else if (object.kind === "rotate") rotate(mesh, place, object)
			else extrude(mesh, place, object)
		}
	} catch (error) {
		if (error instanceof TooManyTriangles) return undefined

		throw error
	}

	const count = mesh.count
	const p = mesh.positions
	const projected = new Float64Array(count * 6)
	const depth = new Float64Array(count)
	const keep = new Uint8Array(count)
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY

	for (let t = 0; t < count; t++) {
		let behind = false

		for (let v = 0; v < 3; v++) {
			const at = t * 9 + v * 3
			const z = p[at + 2] ?? 0

			if (scene.perspective && z >= -1e-6) behind = true

			const scale = scene.perspective ? 1 / -z : 1
			const x = (p[at] ?? 0) * scale
			const y = -(p[at + 1] ?? 0) * scale

			projected[t * 6 + v * 2] = x
			projected[t * 6 + v * 2 + 1] = y
		}

		if (behind) continue

		const ax = projected[t * 6] ?? 0
		const ay = projected[t * 6 + 1] ?? 0
		const area =
			((projected[t * 6 + 2] ?? 0) - ax) * ((projected[t * 6 + 5] ?? 0) - ay) -
			((projected[t * 6 + 3] ?? 0) - ay) * ((projected[t * 6 + 4] ?? 0) - ax)
		// A face turns away from the eye when its plane's normal, turned to the side its vertex normals point to, points
		// away from it.
		const at = t * 9
		const n = mesh.normals
		const ex = (p[at + 3] ?? 0) - (p[at] ?? 0)
		const ey = (p[at + 4] ?? 0) - (p[at + 1] ?? 0)
		const ez = (p[at + 5] ?? 0) - (p[at + 2] ?? 0)
		const fx = (p[at + 6] ?? 0) - (p[at] ?? 0)
		const fy = (p[at + 7] ?? 0) - (p[at + 1] ?? 0)
		const fz = (p[at + 8] ?? 0) - (p[at + 2] ?? 0)
		let gx = ey * fz - ez * fy
		let gy = ez * fx - ex * fz
		let gz = ex * fy - ey * fx

		if (
			gx * ((n[at] ?? 0) + (n[at + 3] ?? 0) + (n[at + 6] ?? 0)) +
				gy * ((n[at + 1] ?? 0) + (n[at + 4] ?? 0) + (n[at + 7] ?? 0)) +
				gz * ((n[at + 2] ?? 0) + (n[at + 5] ?? 0) + (n[at + 8] ?? 0)) <
			0
		) {
			gx = -gx
			gy = -gy
			gz = -gz
		}

		const facing = scene.perspective
			? -(
					gx * ((p[at] ?? 0) + (p[at + 3] ?? 0) + (p[at + 6] ?? 0)) +
					gy * ((p[at + 1] ?? 0) + (p[at + 4] ?? 0) + (p[at + 7] ?? 0)) +
					gz * ((p[at + 2] ?? 0) + (p[at + 5] ?? 0) + (p[at + 8] ?? 0))
				) >= 0
			: gz >= 0

		if (area === 0 || (!facing && (mesh.solids[t] === true || mesh.materials[t]?.culling === true))) continue

		keep[t] = 1
		depth[t] = ((p[t * 9 + 2] ?? 0) + (p[t * 9 + 5] ?? 0) + (p[t * 9 + 8] ?? 0)) / 3

		for (let v = 0; v < 3; v++) {
			const x = projected[t * 6 + v * 2] ?? 0
			const y = projected[t * 6 + v * 2 + 1] ?? 0

			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}

	const order: number[] = []

	for (let t = 0; t < count; t++) if (keep[t] === 1) order.push(t)

	if (order.length === 0) return undefined

	// LibreOffice fits the projection of the scene's bounding box (its members' bounds in the scene's own space) to
	// the frame, so a sphere sits inside it with a margin and a cube fills it.
	const box = sceneBounds(scene, view)

	if (box !== undefined) [minX, minY, maxX, maxY] = box
	if (!(maxX > minX && maxY > minY)) return undefined

	// Farthest first.
	order.sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0))

	// The projection's bounds fill the frame (LibreOffice fits a scene's projection to its rectangle).
	const sx = width / (maxX - minX)
	const sy = height / (maxY - minY)
	const points = new Float32Array(order.length * 6)
	const colors = new Uint32Array(order.length * 3)
	const shade = new Float64Array(3)
	const flat = new Float64Array(3)

	order.forEach((t, k) => {
		const material = mesh.materials[t]

		if (material === undefined) return

		const smooth = scene.smooth && material.normals !== "flat"

		if (!smooth) {
			const at = t * 9
			const n =
				material.normals === "flat"
					? normalized(
							cross(
								[(p[at + 3] ?? 0) - (p[at] ?? 0), (p[at + 4] ?? 0) - (p[at + 1] ?? 0), (p[at + 5] ?? 0) - (p[at + 2] ?? 0)],
								[(p[at + 6] ?? 0) - (p[at] ?? 0), (p[at + 7] ?? 0) - (p[at + 1] ?? 0), (p[at + 8] ?? 0) - (p[at + 2] ?? 0)]
							)
						)
					: normalized([
							(mesh.normals[at] ?? 0) + (mesh.normals[at + 3] ?? 0) + (mesh.normals[at + 6] ?? 0),
							(mesh.normals[at + 1] ?? 0) + (mesh.normals[at + 4] ?? 0) + (mesh.normals[at + 7] ?? 0),
							(mesh.normals[at + 2] ?? 0) + (mesh.normals[at + 5] ?? 0) + (mesh.normals[at + 8] ?? 0)
						])

			const centreX = ((p[t * 9] ?? 0) + (p[t * 9 + 3] ?? 0) + (p[t * 9 + 6] ?? 0)) / 3
			const centreY = ((p[t * 9 + 1] ?? 0) + (p[t * 9 + 4] ?? 0) + (p[t * 9 + 7] ?? 0)) / 3

			lit(scene, material, centreX, centreY, depth[t] ?? 0, n, flat)
		}

		// Every triangle counter-clockwise on screen, so the outline's non-zero fill never cancels an overlap.
		const ax = projected[t * 6] ?? 0
		const ay = projected[t * 6 + 1] ?? 0
		const area =
			((projected[t * 6 + 2] ?? 0) - ax) * ((projected[t * 6 + 5] ?? 0) - ay) -
			((projected[t * 6 + 3] ?? 0) - ay) * ((projected[t * 6 + 4] ?? 0) - ax)
		const vertices = area < 0 ? [0, 1, 2] : [0, 2, 1]

		vertices.forEach((v, slot) => {
			const x = ((projected[t * 6 + v * 2] ?? 0) - minX) * sx
			const y = ((projected[t * 6 + v * 2 + 1] ?? 0) - minY) * sy

			points[k * 6 + slot * 2] = x
			points[k * 6 + slot * 2 + 1] = y

			if (smooth) {
				const at = t * 9 + v * 3

				lit(
					scene,
					material,
					p[at] ?? 0,
					p[at + 1] ?? 0,
					p[at + 2] ?? 0,
					[mesh.normals[at] ?? 0, mesh.normals[at + 1] ?? 0, mesh.normals[at + 2] ?? 0],
					shade
				)
				colors[k * 3 + slot] = packed(shade[0] ?? 0, shade[1] ?? 0, shade[2] ?? 0, material.alpha)
			} else {
				colors[k * 3 + slot] = packed(flat[0] ?? 0, flat[1] ?? 0, flat[2] ?? 0, material.alpha)
			}
		})
	})

	return { points, colors }
}

interface SceneMesh {
	readonly points: Float32Array
	readonly colors: Uint32Array
}

// Meshes made, by scene content and size, least recently used out: a deck repeats few scenes on many slides, each
// tessellated, lit and sorted once. Bounded by bytes; a mesh over the per-entry share is made each time instead of
// being held.
const MESH_CACHE_BYTES = 16 * 1024 * 1024
const MESH_ENTRY_BYTES = 1024 * 1024
const meshes = new Map<string, SceneMesh | null>()
let meshBytes = 0
// A scene's content as a key (every field that changes its mesh: camera, lights, materials, geometry, transforms).
const keys = new WeakMap<Dr3dScene, string>()

function sceneKey(scene: Dr3dScene): string {
	let key = keys.get(scene)

	if (key === undefined) {
		key = JSON.stringify(scene, (_name, value: unknown) => (ArrayBuffer.isView(value) ? Array.from(value as Float64Array) : value))
		keys.set(scene, key)
	}

	return key
}

function cachedMesh(scene: Dr3dScene, width: number, height: number): SceneMesh | undefined {
	const key = `${String(width)}x${String(height)}|${sceneKey(scene)}`
	const held = meshes.get(key)

	if (held !== undefined) {
		meshes.delete(key)
		meshes.set(key, held)

		return held ?? undefined
	}

	const made = meshOf(scene, width, height)
	const bytes = made === undefined ? 0 : made.points.byteLength + made.colors.byteLength

	if (bytes > MESH_ENTRY_BYTES) return made

	meshes.set(key, made ?? null)
	meshBytes += bytes + key.length * 2

	for (const [oldest, mesh] of meshes) {
		if (meshBytes <= MESH_CACHE_BYTES) break

		meshes.delete(oldest)
		meshBytes -= (mesh === null ? 0 : mesh.points.byteLength + mesh.colors.byteLength) + oldest.length * 2
	}

	return made
}

// Draws `scene` into `list` through `matrix` (the frame's px to the list's), fitted to `width` x `height` px. False
// when it draws nothing (no visible triangle) or is over its triangle budget.
export function drawScene(list: DrawingList, scene: Dr3dScene, matrix: readonly number[], width: number, height: number): boolean {
	if (!(width > 0 && height > 0)) return false

	const mesh = cachedMesh(scene, width, height)

	if (mesh === undefined) return false

	// Each drawing gets its own arrays: a render's buffers are transferred to the page (detached here), the cache's never.
	const points = mesh.points.slice()
	const firstCommand = list.commandCount
	const firstCoord = list.coordCount

	for (let k = 0; k + 5 < points.length; k += 6) {
		list.moveTo(points[k] ?? 0, points[k + 1] ?? 0)
		list.lineTo(points[k + 2] ?? 0, points[k + 3] ?? 0)
		list.lineTo(points[k + 4] ?? 0, points[k + 5] ?? 0)
		list.close()
	}

	const paint = list.paint({ kind: "shaded", points, colors: mesh.colors.slice(), ramp: null })

	list.addItem(ItemKind.PATH, matrix, 0, 0, width, height, firstCommand, firstCoord, paint, -1, -1, -1, 0, 0)

	return true
}
