import {
	Relationships,
	joinBytes,
	partKey,
	parseRelationships,
	relationshipsPartName,
	type OpcPackage,
	type PartBytes,
	type ZipChanges
} from "../../opc/index"
import { DeckTally, DEFAULT_PRESENTATION_BUDGETS } from "../../presentation/budget"
import { classifyAction } from "../../presentation/actions"
import {
	PATH_ARC,
	PATH_CLOSE,
	PATH_CUBIC,
	PATH_LINE,
	PATH_MOVE,
	PATH_QUAD,
	refused,
	slideRef,
	type CustomPath,
	type Geometry,
	type GeometryGuide,
	type Refused,
	type ShapeNode,
	type SlideNode,
	type SlideRef
} from "../../presentation/model"
import { Namespaces, NodeKind, parseXml, type XmlDocument } from "../../xml/index"
import { fillChild, readBlipFill, readEffects, readFill, readLine, type ReadContext } from "../read/drawing"
import { readSlidePart } from "../read/slide"
import { G, partReader, type PartReader } from "../read/xml"
import { sameModel } from "./emit/shape"

// Proof gate 2 (every save, before the package is handed out): each written slide is read back from the bytes that
// will be stored and compared with the session's model at the snapshot's revision, after normalisation (node
// ids, revisions and source refs dropped, slides named by their parts); the presentation's slide list and sections
// read back as the deck holds them; every relationship of a changed part names a part the package has. A mismatch
// refuses the save (proofFailed) with what differed.

// A slide as gate 2 compares it: plain data, slide references replaced by part names.
export interface NormalSlide {
	readonly part: string
	readonly value: Readonly<Record<string, unknown>>
}

type PartOf = (ref: SlideRef) => string | undefined

// A deep copy without source refs and with slide references as their parts (an Action { kind: "slide" }).
function clean(value: unknown, partOf: PartOf): unknown {
	if (value === null || typeof value !== "object") return value
	if (value instanceof Float64Array) return new Float64Array(value)
	if (value instanceof Uint8Array) return new Uint8Array(value)
	if (Array.isArray(value)) return value.map(item => clean(item, partOf))

	const record = value as Record<string, unknown>

	if (record["kind"] === "slide" && typeof record["slide"] === "number" && Object.keys(record).length === 2) {
		const part = partOf(record["slide"] as SlideRef)

		return part === undefined ? { kind: "internal", jump: "next" } : { kind: "slide", part: partKey(part) }
	}

	const out: Record<string, unknown> = {}

	for (const [key, item] of Object.entries(record)) {
		if (key === "src" || item === undefined) continue

		out[key] = clean(item, partOf)
	}

	return out
}

// A picture fill without what names its image: an inserted image is a registry id in the session and a part once
// written (the relationship check proves the part is there), and its adjustments are only partly modelled.
function normalFill(fill: unknown): unknown {
	if (fill === null || typeof fill !== "object" || (fill as { kind?: unknown }).kind !== "picture") return fill

	const { part: _part, inserted: _inserted, adjust: _adjust, ...rest } = fill as Record<string, unknown>

	return rest
}

function normalShape(shape: ShapeNode, partOf: PartOf): Record<string, unknown> {
	const props = shape.props
	const text =
		shape.text === undefined
			? undefined
			: { ...shape.text, bodyPr: props?.bodyPr === undefined ? shape.text.bodyPr : { ...shape.text.bodyPr, ...props.bodyPr } }

	return clean(
		{
			kind: shape.kind,
			id: shape.sourceId ?? shape.id,
			name: shape.name,
			hidden: shape.hidden,
			alt: shape.alt,
			ph: shape.ph,
			txBox: shape.txBox,
			xfrm: shape.xfrm,
			style: shape.style,
			actions: shape.actions,
			text,
			geometry: props?.geometry,
			fill: normalFill(props?.fill),
			ln: props?.ln,
			effects: props?.effects?.effects,
			children: shape.children?.map(child => normalShape(child, partOf))
		},
		partOf
	) as Record<string, unknown>
}

// The slide as the session holds it (at the snapshot, before later ops change it).
export function normalSlide(part: string, node: SlideNode, layoutPart: string | undefined, partOf: PartOf): NormalSlide {
	return {
		part,
		value: clean(
			{
				kind: node.kind,
				hidden: node.hidden,
				showMasterShapes: node.showMasterShapes,
				name: node.name,
				layout: layoutPart === undefined ? undefined : partKey(layoutPart),
				// No override and "use the master's" read alike (§19.3.1.7: the master's mapping applies either way).
				clrMapOvr:
					node.clrMapOvr ??
					(node.kind === "master" || node.kind === "notesMaster" || node.kind === "handoutMaster" ? undefined : "master"),
				hf: node.hf,
				shapes: node.shapes.map(shape => normalShape(shape, partOf))
			},
			partOf
		) as Record<string, unknown>
	}
}

// --- Geometry read back (the model reads geometry only from edits; gate 2 reads what was written) ---

function guides(r: PartReader, list: number): GeometryGuide[] {
	return r.children(list, G.A, "gd").map(gd => ({ name: r.attr(gd, "name") ?? "", formula: r.attr(gd, "fmla") ?? "" }))
}

function pathOf(r: PartReader, path: number): CustomPath {
	const commands: number[] = []
	const coords: number[] = []
	const point = (pt: number): void => {
		coords.push(r.number(pt, "x") ?? 0, r.number(pt, "y") ?? 0)
	}

	for (let child = r.first(path); child >= 0; child = r.next(child)) {
		const pts = r.children(child, G.A, "pt")

		switch (r.local(child)) {
			case "moveTo":
				commands.push(PATH_MOVE)
				pts.slice(0, 1).forEach(point)
				break
			case "lnTo":
				commands.push(PATH_LINE)
				pts.slice(0, 1).forEach(point)
				break
			case "cubicBezTo":
				commands.push(PATH_CUBIC)
				pts.slice(0, 3).forEach(point)
				break
			case "quadBezTo":
				commands.push(PATH_QUAD)
				pts.slice(0, 2).forEach(point)
				break
			case "arcTo":
				commands.push(PATH_ARC)
				coords.push(
					r.number(child, "wR") ?? 0,
					r.number(child, "hR") ?? 0,
					r.number(child, "stAng") ?? 0,
					r.number(child, "swAng") ?? 0
				)
				break
			case "close":
				commands.push(PATH_CLOSE)
				break
		}
	}

	const fill = r.attr(path, "fill") ?? "norm"

	return {
		w: r.number(path, "w") ?? 0,
		h: r.number(path, "h") ?? 0,
		fill: (["norm", "none", "lighten", "lightenLess", "darken", "darkenLess"].includes(fill) ? fill : "norm") as CustomPath["fill"],
		stroke: r.bool(path, "stroke") ?? true,
		extrusionOk: r.bool(path, "extrusionOk") ?? true,
		commands: Uint8Array.from(commands),
		coords: Float64Array.from(coords)
	}
}

export function readGeometry(r: PartReader, spPr: number): Geometry | undefined {
	const preset = r.child(spPr, G.A, "prstGeom")

	if (preset >= 0) return { kind: "preset", preset: r.attr(preset, "prst") ?? "rect", guides: guides(r, r.child(preset, G.A, "avLst")) }

	const custom = r.child(spPr, G.A, "custGeom")

	if (custom < 0) return undefined

	const rect = r.child(custom, G.A, "rect")

	return {
		kind: "custom",
		guides: [...guides(r, r.child(custom, G.A, "avLst")), ...guides(r, r.child(custom, G.A, "gdLst"))],
		paths: r.children(r.child(custom, G.A, "pathLst"), G.A, "path").map(path => pathOf(r, path)),
		...(rect < 0
			? {}
			: {
					textRect: {
						l: r.attr(rect, "l") ?? "l",
						t: r.attr(rect, "t") ?? "t",
						r: r.attr(rect, "r") ?? "r",
						b: r.attr(rect, "b") ?? "b"
					}
				})
	}
}

function zipPart(name: string): string {
	return name.startsWith("/") ? name.slice(1) : name
}

// --- The package as it will be stored ---

// The final package: changed parts from the snapshot, the rest from the base.
export class FinalPackage {
	private readonly base: OpcPackage
	private readonly changed = new Map<string, PartBytes>()
	private readonly removed = new Set<string>()

	constructor(base: OpcPackage, changes: ZipChanges) {
		this.base = base

		for (const change of [...(changes.replace ?? []), ...(changes.add ?? [])]) this.changed.set(partKey(change.name), change.bytes)
		for (const name of changes.remove ?? []) this.removed.add(partKey(name))
	}

	has(name: string): boolean {
		const key = partKey(name)

		return this.changed.has(key) || (!this.removed.has(key) && this.base.has(name))
	}

	isChanged(name: string): boolean {
		return this.changed.has(partKey(name))
	}

	async read(name: string): Promise<Uint8Array> {
		const held = this.changed.get(partKey(name))

		if (held !== undefined) return joinBytes(held)

		return this.base.read(name)
	}

	async relationships(source: string): Promise<Relationships> {
		const rels = relationshipsPartName(this.base.entry(source)?.name ?? source)

		if (!this.has(rels)) return new Relationships([])
		// An unchanged relationships part is the base's (parsed once there).
		if (!this.changed.has(partKey(rels)) && this.base.has(source)) return this.base.relationships(source)

		return parseRelationships(await this.read(rels), source)
	}

	// The save removes a part.
	get removes(): boolean {
		return this.removed.size > 0
	}

	// Every part name of the package as it will be stored.
	names(): string[] {
		const out = [...this.changed.keys()]

		for (const entry of this.base.entries()) {
			const key = partKey(entry.name)

			if (!this.changed.has(key) && !this.removed.has(key)) out.push(entry.name)
		}

		return out
	}

	baseHas(name: string): boolean {
		return this.base.has(name)
	}

	baseRelationships(source: string): Promise<Relationships> {
		return this.base.has(source) ? this.base.relationships(source) : Promise.resolve(new Relationships([]))
	}

	changedNames(): string[] {
		return [...this.changed.keys()]
	}
}

// What one written slide reads back as.
async function readWritten(
	final: FinalPackage,
	part: string,
	parsed: Map<string, XmlDocument>
): Promise<{ node: SlideNode; layout: string | undefined; partOf: PartOf } | Refused> {
	const name = part.startsWith("/") ? part.slice(1) : part

	if (!final.has(name)) return refused("proofFailed", `${part} is missing from the written package`)

	let document: XmlDocument

	try {
		document = parsed.get(partKey(name)) ?? parseXml(await final.read(name))
		parsed.set(partKey(name), document)
	} catch (error) {
		return refused("proofFailed", `${part} does not parse: ${error instanceof Error ? error.message : String(error)}`)
	}

	const relationships = await final.relationships(name)
	const refs = new Map<string, SlideRef>()
	const parts = new Map<SlideRef, string>()
	const refOf = (target: string): SlideRef => {
		const key = partKey(target)
		let ref = refs.get(key)

		if (ref === undefined) {
			ref = slideRef(refs.size + 1)
			refs.set(key, ref)
			parts.set(ref, target)
		}

		return ref
	}
	const read = readSlidePart({
		ref: slideRef(0),
		part,
		document,
		relationships,
		epoch: 0,
		tally: new DeckTally(DEFAULT_PRESENTATION_BUDGETS),
		media: { contentType: () => undefined, size: () => undefined },
		refOf,
		themeOf: () => undefined,
		action: (reader, rels, target) => {
			const id = reader.rel(target, "id")
			const relationship = id === undefined || id === "" ? undefined : rels.byId(id)
			const action = reader.attr(target, "action")

			return classifyAction(
				{
					...(action === undefined ? {} : { action }),
					...(relationship === undefined
						? {}
						: {
								target: {
									external: relationship.external,
									target: relationship.target,
									...(relationship.partName === undefined ? {} : { partName: `/${relationship.partName}` })
								}
							})
				},
				{ slideOf: target => (relationshipTo(rels, target) === "slide" ? refOf(target) : undefined) }
			)
		}
	})
	// Slide → layout, layout → master, notes → notes master.
	const parentType = { slide: "/slideLayout", layout: "/slideMaster", notes: "/notesMaster" }[read.node.kind as "slide"]
	const layout =
		parentType === undefined
			? undefined
			: relationships.all.find(relationship => !relationship.external && relationship.type.endsWith(parentType))

	// Shapes read again carry what the source holds of the groups an edit writes, for the comparison.
	const r = partReader(document)
	const context: ReadContext = {
		reader: r,
		part,
		epoch: 0,
		relationships,
		tally: new DeckTally(DEFAULT_PRESENTATION_BUDGETS),
		action: () => undefined
	}
	const groups = (shape: ShapeNode): void => {
		if (shape.src !== undefined) {
			const spPr = r.child(shape.src.node, G.P, shape.kind === "grpSp" ? "grpSpPr" : "spPr")

			if (spPr >= 0) {
				const blipFill = shape.kind === "pic" ? r.child(shape.src.node, G.P, "blipFill") : -1
				// A picture's own fill is its p:blipFill (the model's picture fill on a p:pic).
				const fill = blipFill >= 0 ? readBlipFill(context, blipFill) : readFill(context, fillChild(r, spPr))
				const ln = r.child(spPr, G.A, "ln")
				const effects = r.child(spPr, G.A, "effectLst")
				const geometry = readGeometry(r, spPr)

				shape.props = {
					...(geometry === undefined ? {} : { geometry }),
					...(fill === undefined ? {} : { fill }),
					...(ln < 0 ? {} : { ln: readLine(context, ln) }),
					...(effects < 0 ? {} : { effects: readEffects(context, effects) })
				}
			}
		}

		for (const child of shape.children ?? []) groups(child)
	}

	for (const shape of read.node.shapes) groups(shape)

	return { node: read.node, layout: layout?.partName === undefined ? undefined : `/${layout.partName}`, partOf: ref => parts.get(ref) }
}

function relationshipTo(rels: Relationships, target: string): string | undefined {
	const key = partKey(target)
	const found = rels.all.find(relationship => relationship.partName !== undefined && partKey(`/${relationship.partName}`) === key)

	return found?.type.slice(found.type.lastIndexOf("/") + 1)
}

// The differences between an expected and a written value, by path ("" when equal); group values the expectation
// leaves out (an unedited fill is the source's) are not compared.
function difference(expected: unknown, written: unknown, path: string): string {
	if (sameModel(expected, written)) return ""
	if (
		expected !== null &&
		written !== null &&
		typeof expected === "object" &&
		typeof written === "object" &&
		!Array.isArray(expected) &&
		!ArrayBuffer.isView(expected)
	) {
		const left = expected as Record<string, unknown>
		const right = written as Record<string, unknown>

		for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
			if ((key === "geometry" || key === "fill" || key === "ln" || key === "effects") && left[key] === undefined) continue

			const inner = difference(left[key], right[key], `${path}.${key}`)

			if (inner !== "") return inner
		}

		return ""
	}

	if (Array.isArray(expected) && Array.isArray(written) && expected.length === written.length) {
		for (let k = 0; k < expected.length; k++) {
			const inner = difference(expected[k], written[k], `${path}[${String(k)}]`)

			if (inner !== "") return inner
		}

		return ""
	}

	const show = (value: unknown): string => (JSON.stringify(value) ?? "undefined").slice(0, 160)

	return `${path === "" ? "(root)" : path}: expected ${show(expected)}, written ${show(written)}`
}

export interface GateExpectation {
	readonly slides: readonly NormalSlide[]
	// The deck's slide parts in order and its sections by part.
	readonly slideParts: readonly string[]
	readonly sections: readonly { readonly name: string; readonly id: string; readonly slides: readonly string[] }[]
	readonly mainPart: string
	// Relationship targets the base package already lacked, carried into copies.
	readonly inheritedMissing: readonly string[]
	// The relationship ids each new part's markup came with (a copy's, a restored part's), by part key: an id its
	// markup names that the source already lacked is the source's, not this save's.
	readonly seeded?: ReadonlyMap<string, readonly string[]>
}

const RELATIONSHIP_NAMESPACES: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
])

// The relationship ids a part's markup names (r:id, r:embed, r:link, r:pict… under any prefix bound to the
// relationships namespace), empty ones (a removed jump's) left out.
function markupIds(document: XmlDocument): Set<string> {
	const namespaces = new Namespaces(document, { lenient: true })
	const out = new Set<string>()

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || document.attributeSpans(node).length === 0) continue

		for (const attribute of document.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon <= 0 || attribute.value === "") continue

			const prefix = attribute.name.slice(0, colon)

			if (prefix !== "xmlns" && RELATIONSHIP_NAMESPACES.has(namespaces.uri(node, prefix) ?? "")) out.add(attribute.value)
		}
	}

	return out
}

// Gate 2 over the package as it will be stored.
export async function verifyFinal(final: FinalPackage, expectation: GateExpectation): Promise<Refused | undefined> {
	// Documents parsed once for every check (keyed by part key).
	const parsed = new Map<string, XmlDocument>()

	for (const expected of expectation.slides) {
		const written = await readWritten(final, expected.part, parsed)

		if ("kind" in written) return written

		const actual = normalSlide(expected.part, written.node, written.layout, written.partOf)
		const differs = difference(expected.value, actual.value, "")

		if (differs !== "") return refused("proofFailed", `${expected.part} reads back differently at ${differs}`)
	}

	// The slide list and sections, by part.
	const main = expectation.mainPart
	const document = parsed.get(partKey(zipPart(main))) ?? parseXml(await final.read(main))

	parsed.set(partKey(zipPart(main)), document)

	const r = partReader(document)
	const root = document.documentElement()
	const relationships = await final.relationships(main)
	const ids = new Map<number, string>()
	const parts: string[] = []

	for (const entry of r.children(r.child(root, G.P, "sldIdLst"), G.P, "sldId")) {
		const rId = r.rel(entry, "id")
		const target = rId === undefined ? undefined : relationships.byId(rId)

		if (target?.partName === undefined || !final.has(target.partName))
			return refused("proofFailed", `A slide id names no slide part (${rId ?? ""})`)

		parts.push(`/${target.partName}`)
		ids.set(r.int(entry, "id") ?? 0, `/${target.partName}`)
	}

	if (
		parts.length !== expectation.slideParts.length ||
		parts.some((part, index) => partKey(part) !== partKey(expectation.slideParts[index] ?? ""))
	) {
		return refused("proofFailed", "The slide list reads back differently")
	}

	if (new Set(ids.keys()).size !== parts.length) return refused("proofFailed", "Two slides share a slide id")

	const ext = r
		.children(r.child(root, G.P, "extLst"), G.P, "ext")
		.find(node => r.attr(node, "uri") === "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}")
	const sections = (ext === undefined ? [] : r.children(r.child(ext, G.P14, "sectionLst"), G.P14, "section")).map(section => ({
		name: r.attr(section, "name") ?? "",
		id: r.attr(section, "id") ?? "",
		slides: r
			.children(r.child(section, G.P14, "sldIdLst"), G.P14, "sldId")
			.map(entry => partKey(ids.get(r.int(entry, "id") ?? -1) ?? ""))
	}))
	const expectedSections = expectation.sections.map(section => ({ ...section, slides: section.slides.map(partKey) }))

	if (
		expectedSections.length > 0 &&
		!sameModel(sections.map(section => section.slides).flat(), expectedSections.map(section => section.slides).flat())
	) {
		return refused("proofFailed", "The sections read back differently")
	}

	// Every relationship of a changed part names a part the package has; when the save removes parts, every
	// relationship of the package does (nothing still points at a removed part).
	for (const name of final.removes ? final.names() : final.changedNames()) {
		const match = /^(.*?)_rels\/([^/]*)\.rels$/iu.exec(name)

		if (match === null) continue

		const source = `${match[1] ?? ""}${match[2] ?? ""}`

		if (source !== "" && !final.has(source)) continue

		const changed = final.isChanged(name)
		const before = changed
			? new Set((await final.baseRelationships(source)).all.map(relationship => `${relationship.id} ${relationship.target}`))
			: undefined

		for (const relationship of (await final.relationships(source)).all) {
			if (relationship.external || relationship.partName === undefined || final.has(relationship.partName)) continue
			// A target the source already lacked (a damaged package) is the source's, not this save's.
			if (
				!final.baseHas(relationship.partName) &&
				(before === undefined ||
					before.has(`${relationship.id} ${relationship.target}`) ||
					expectation.inheritedMissing.includes(partKey(relationship.partName)))
			)
				continue

			return refused("proofFailed", `${source} relates to the missing part ${relationship.partName}`)
		}
	}

	// Every relationship id the markup of a written part names is one of its relationships.
	for (const name of final.changedNames()) {
		if (!/\.xml$/iu.test(name) || name === "[content_types].xml") continue

		let document: XmlDocument

		try {
			document = parsed.get(name) ?? parseXml(await final.read(name))
		} catch {
			continue
		}

		const ids = new Set((await final.relationships(name)).all.map(relationship => relationship.id))
		const missing = [...markupIds(document)].filter(id => !ids.has(id))

		if (missing.length === 0) continue

		// Ids the part's source already lacked are its own (a damaged package); a part written whole has no source.
		const sourceIds = final.baseHas(name)
			? new Set((await final.baseRelationships(name)).all.map(relationship => relationship.id))
			: expectation.seeded?.has(name) === true
				? new Set(expectation.seeded.get(name))
				: undefined
		const dropped = missing.find(id => sourceIds === undefined || sourceIds.has(id))

		if (dropped !== undefined) return refused("proofFailed", `/${name} names the relationship ${dropped}, which it does not have`)
	}

	return undefined
}
