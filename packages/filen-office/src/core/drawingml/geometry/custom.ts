import { appendAll } from "../../arrays"
import { D, type DrawingReader } from "../reader"
import {
	BUILTIN_COUNT,
	GeomCommand,
	LiteralPool,
	OP_BY_FORMULA,
	PATH_FILL_NAMES,
	PATH_NO_STROKE,
	builtinIndex,
	opArity,
	type GeometryProgram
} from "./program"

const NUMBER = /^-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?$/

// Compiles a:custGeom (§20.1.9.8) into a geometry program. Unknown guide names and malformed formulas read
// as 0, as Office treats them; nothing throws.
export function compileCustomGeometry(reader: DrawingReader, node: number): GeometryProgram {
	const pool = new LiteralPool()
	const slots = new Map<string, number>()
	let next = BUILTIN_COUNT
	const argument = (token: string | undefined): number => {
		if (token === undefined || token === "") return pool.ref(0)
		if (NUMBER.test(token)) return pool.ref(Number(token))

		const builtin = builtinIndex(token)

		if (builtin >= 0) return slots.get(token) ?? builtin

		return slots.get(token) ?? pool.ref(0)
	}
	const adjustNames: string[] = []
	const adjustDefaults: number[] = []
	const guides: number[] = []
	const formula = (gd: number): [number, number, number, number] => {
		const [name, ...args] = (reader.attr(gd, "fmla") ?? "").trim().split(/\s+/)
		const op = OP_BY_FORMULA.get(name ?? "")

		if (op === undefined) return [0, pool.ref(0), 0, 0]

		const arity = opArity(op)

		return [op, argument(args[0]), arity > 1 ? argument(args[1]) : 0, arity > 2 ? argument(args[2]) : 0]
	}
	const adjustList = reader.child(node, D.A, "avLst")
	// Adjust values of a custom shape are plain guides whose formula is usually "val n"; they are compiled
	// as guides so any formula works, and listed by name for overrides that never come (custom shapes have
	// no external avLst).
	const definitions = [...reader.children(adjustList, D.A, "gd"), ...reader.children(reader.child(node, D.A, "gdLst"), D.A, "gd")]

	for (const gd of definitions) {
		appendAll(guides, formula(gd))

		const name = reader.attr(gd, "name") ?? ""

		slots.set(name, next++)
	}

	const rectNode = reader.child(node, D.A, "rect")
	const rect =
		rectNode < 0
			? null
			: Int32Array.from([
					argument(reader.attr(rectNode, "l") ?? "l"),
					argument(reader.attr(rectNode, "t") ?? "t"),
					argument(reader.attr(rectNode, "r") ?? "r"),
					argument(reader.attr(rectNode, "b") ?? "b")
				])
	const paths: number[] = []
	const document = reader.document
	const point = (pt: number): void => {
		paths.push(argument(reader.attr(pt, "x")), argument(reader.attr(pt, "y")))
	}

	for (const path of reader.children(reader.child(node, D.A, "pathLst"), D.A, "path")) {
		const fill = Math.max(0, PATH_FILL_NAMES.indexOf(reader.attr(path, "fill") ?? "norm"))
		const stroke = reader.bool(path, "stroke", true)

		paths.push(
			GeomCommand.PATH,
			pool.ref(fill | (stroke ? 0 : PATH_NO_STROKE)),
			argument(reader.attr(path, "w")),
			argument(reader.attr(path, "h"))
		)

		for (let command = document.firstChildElement(path); command >= 0; command = document.nextSiblingElement(command)) {
			if (reader.group(command) !== D.A) continue

			const pts = reader.children(command, D.A, "pt")

			switch (document.localName(command)) {
				case "moveTo":
					if (pts.length < 1) break
					paths.push(GeomCommand.MOVE)
					point(pts[0] ?? -1)
					break
				case "lnTo":
					if (pts.length < 1) break
					paths.push(GeomCommand.LINE)
					point(pts[0] ?? -1)
					break
				case "arcTo":
					paths.push(
						GeomCommand.ARC,
						argument(reader.attr(command, "wR")),
						argument(reader.attr(command, "hR")),
						argument(reader.attr(command, "stAng")),
						argument(reader.attr(command, "swAng"))
					)
					break
				case "quadBezTo":
					if (pts.length < 2) break
					paths.push(GeomCommand.QUAD)
					point(pts[0] ?? -1)
					point(pts[1] ?? -1)
					break
				case "cubicBezTo":
					if (pts.length < 3) break
					paths.push(GeomCommand.CUBIC)
					point(pts[0] ?? -1)
					point(pts[1] ?? -1)
					point(pts[2] ?? -1)
					break
				case "close":
					paths.push(GeomCommand.CLOSE)
					break
				default:
					break
			}
		}
	}

	return {
		adjustNames,
		adjustDefaults: Float64Array.from(adjustDefaults),
		slotCount: next,
		guides: Int32Array.from(guides),
		guideCount: guides.length / 4,
		rect,
		paths: Int32Array.from(paths),
		literals: Float64Array.from(pool.values)
	}
}
