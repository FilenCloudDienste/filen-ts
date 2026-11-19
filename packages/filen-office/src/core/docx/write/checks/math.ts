import { NodeKind, type XmlDocument } from "../../../xml/index"
import { MAX_OMML_DEPTH, OMML_NAMESPACE } from "../../../math/ommlWriter"
import { Ns } from "../../model/namespaces"
import { partReader, type PartReader } from "../../model/reader"
import { STRICT_OMML_NAMESPACE } from "../atoms/math"
import { DocxVerifyError } from "../failure"
import type { StoryPart } from "../../model/index"
import type { DocxCheck } from "./index"

// Equations the save wrote (the part's own markup; equations copied from the source are left as they were):
// every math element is one of Office Math's (shared-math.xsd, without the document settings of m:mathPr), in
// the math namespace of the document's conformance class, carrying no attributes but m:val, m:alnAt, xml:space and
// declarations of that namespace or of one the part's root or its own equations declare; inside them only math, WordprocessingML and
// Markup Compatibility elements (what those hold, as Word 365's w14 run effects, is theirs);
// equations start at m:oMath or m:oMathPara and go no deeper than readers read them (MAX_OMML_DEPTH).
// Copies of source markup inside them (<_/> in a story part's skeleton) are the source's, and so is an equation
// of the source copied whole into a rewritten paragraph (it is not the save's markup). Their tracked changes
// (w:ins / w:del around runs and in m:ctrlPr) carry an id and an author; gate 2 counts the ids as every revision's.

export const OMML_ELEMENTS: ReadonlySet<string> = new Set(
	(
		"acc accPr aln alnScr argPr argSz bar barPr baseJc begChr borderBox borderBoxPr box boxPr brk cGp cGpRule cSp chr count " +
		"ctrlPr d dPr deg degHide den diff e endChr eqArr eqArrPr f fName fPr func funcPr groupChr groupChrPr grow hideBot hideLeft " +
		"hideRight hideTop jc lim limLoc limLow limLowPr limUpp limUppPr lit m mPr maxDist mc mcJc mcPr mcs mr nary naryPr noBreak " +
		"nor num oMath oMathPara oMathParaPr objDist opEmu phant phantPr plcHide pos r rPr rSp rSpRule rad radPr sPre sPrePr sSub " +
		"sSubPr sSubSup sSubSupPr sSup sSupPr scr sepChr show shp strikeBLTR strikeH strikeTLBR strikeV sty sub subHide sup supHide " +
		"t transp type vertJc zeroAsc zeroDesc zeroWid"
	).split(" ")
)

const ALLOWED_INSIDE = new Set<Ns>([Ns.M, Ns.W, Ns.MC])
const CHANGES: ReadonlySet<string> = new Set(["ins", "del", "moveFrom", "moveTo"])
const INTEGER = /^-?\d{1,10}$/
// Attributes of Office Math elements (shared-math.xsd: m:val, and m:brk's m:alnAt).
const MATH_ATTRIBUTES: ReadonlySet<string> = new Set(["val", "alnAt"])

// Why equation markup in `document` cannot be written (undefined: it can). `declared`: the namespaces the
// part's root and its equations declare; `skeleton`: copies of source markup stand as <_/>; `copied`: whether
// an equation (its root element) is a copy of the source's, as it was. The editor asks this of an equation's
// new XML before a command gives it (a command that could not be saved is refused), gate 2 of what a save wrote.
export function equationMarkupFault(
	document: XmlDocument,
	reader: PartReader,
	expected: string,
	declared: ReadonlySet<string>,
	skeleton: boolean,
	copied?: (root: number) => boolean
): string | undefined {
	const namespaces = reader.namespaces
	// Depth of each element inside an equation (its root 0), -1 outside one; parents come first.
	const depths = new Int32Array(document.count).fill(-1)
	// Bytes before this end an equation copied from the source (its elements are the source's).
	let skipTo = -1

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || document.start(node) < skipTo) continue

		const fault = elementFault(node)

		if (fault === undefined) continue

		// Asked only of a fault (rare): an equation of the source as it was is not the save's to judge.
		let root = node

		while ((depths[document.parent(root)] ?? -1) >= 0) root = document.parent(root)

		if (copied === undefined || (depths[root] ?? -1) < 0 || !copied(root)) return fault

		skipTo = document.end(root)
	}

	return undefined

	function elementFault(node: number): string | undefined {
		const parent = document.parent(node)
		const outer = parent < 0 ? -1 : (depths[parent] ?? -1)
		const group = reader.group(node)

		if (outer < 0 && group !== Ns.M) return undefined

		const depth = outer + 1
		const name = document.name(node)

		depths[node] = depth

		if (depth > MAX_OMML_DEPTH) return `is nested too deep (${name})`
		// A copy of the source's own markup (a range marker an edited equation keeps) stands as <_/>.
		if (skeleton && name === "_") return undefined
		// What WordprocessingML and Markup Compatibility elements hold is theirs to say (math inside a revision
		// wrapper is checked all the same, and so is a revision inside one).
		if (group !== Ns.M && outer >= 0 && reader.group(parent) !== Ns.M && !(group === Ns.W && CHANGES.has(document.localName(node))))
			return undefined
		if (!ALLOWED_INSIDE.has(group)) return `holds an element of another vocabulary (${name})`

		// A tracked change inside it names itself and its author (CT_TrackChange).
		if (group === Ns.W && CHANGES.has(document.localName(node))) {
			if (!INTEGER.test(reader.attr(node, Ns.W, "id") ?? "")) return `holds a change without an id (${name})`
			if ((reader.attr(node, Ns.W, "author") ?? "") === "") return `holds a change without an author (${name})`
		}

		if (group !== Ns.M) return undefined

		const local = document.localName(node)

		if (namespaces.elementUri(node) !== expected) return `is in another math namespace (${name})`
		if (!OMML_ELEMENTS.has(local)) return `holds an element Office Math does not have (${name})`
		if (depth === 0 && local !== "oMath" && local !== "oMathPara") return `does not start at m:oMath (${name})`

		for (const attribute of document.attributes(node)) {
			const qualified = attribute.name
			const colon = qualified.indexOf(":")
			const prefix = colon < 0 ? "" : qualified.slice(0, colon)

			if (qualified === "xmlns" || prefix === "xmlns") {
				if (attribute.value !== expected && !declared.has(attribute.value)) return `declares another namespace (${name})`
			} else if (
				qualified !== "xml:space" &&
				(prefix === "" || !MATH_ATTRIBUTES.has(qualified.slice(colon + 1)) || namespaces.uri(node, prefix) !== expected)
			) {
				return `has attribute ${qualified} (${name})`
			}
		}

		return undefined
	}
}

// The namespaces a part's root declares.
export function rootNamespaces(document: XmlDocument, reader: PartReader): ReadonlySet<string> {
	return new Set(reader.namespaces.declarations().get(document.documentElement())?.values() ?? [])
}

const sourceNamespaces = new WeakMap<StoryPart, ReadonlySet<string>>()

// The namespaces the source of a story part declares, wherever (its root, a paragraph, an equation or a change
// in one: an equation of the file using Word 365's w16du keeps it as it is edited, its new XML declaring it).
export function equationNamespaces(part: StoryPart): ReadonlySet<string> {
	let known = sourceNamespaces.get(part)

	if (known === undefined) {
		const own = new Set<string>()

		for (const bindings of part.reader.namespaces.declarations().values()) for (const uri of bindings.values()) own.add(uri)

		known = own
		sourceNamespaces.set(part, known)
	}

	return known
}

const sourceRoots = new WeakMap<StoryPart, ReadonlyMap<number, readonly number[]>>()

// Whether element `root` of `document` is, byte for byte, an equation of the source part (copied as it was).
function sourceEquation(part: StoryPart, document: XmlDocument, root: number): boolean {
	let roots = sourceRoots.get(part)

	if (roots === undefined) {
		// The source's equation roots by length (math elements whose parent is not one).
		const byLength = new Map<number, number[]>()
		const source = part.document

		for (let node = 0; node < source.count; node++) {
			if (source.kinds[node] !== NodeKind.Element || part.reader.group(node) !== Ns.M) continue

			const parent = source.parent(node)

			if (parent >= 0 && part.reader.group(parent) === Ns.M) continue

			const length = source.end(node) - source.start(node)
			const list = byLength.get(length)

			if (list === undefined) byLength.set(length, [source.start(node)])
			else list.push(source.start(node))
		}

		roots = byLength
		sourceRoots.set(part, roots)
	}

	const start = document.start(root)
	const length = document.end(root) - start
	const bytes = document.bytes
	const source = part.document.bytes

	return (roots.get(length) ?? []).some(from => {
		for (let k = 0; k < length; k++) if (bytes[start + k] !== source[from + k]) return false

		return true
	})
}

export const mathChecks: readonly DocxCheck[] = [
	{
		newMarkupOnly: true,
		part(input, checked) {
			if (checked.part === undefined || (!checked.skeleton && input.original.has(checked.name))) return

			const document = checked.document
			const reader = partReader(document)
			const expected = input.context.model.strict ? STRICT_OMML_NAMESPACE : OMML_NAMESPACE
			const part = checked.part
			const declared = new Set([...rootNamespaces(document, reader), ...equationNamespaces(part)])
			const fault = equationMarkupFault(document, reader, expected, declared, checked.skeleton, root =>
				sourceEquation(part, document, root)
			)

			if (fault !== undefined) throw new DocxVerifyError("content", `${checked.name}: an equation ${fault}`)
		}
	}
]
