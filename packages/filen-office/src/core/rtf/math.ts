import { escapeAttribute, escapeText } from "../xml/index"

// RTF math (RTF 1.9.1, "Math"): each \\mXxx word names the Office Math element m:xXx (ECMA-376 Part 1 §22.1.2);
// the group it opens is that element. Run text (\\mr) becomes m:t, a property's text or parameter its m:val.

const OMML = "http://schemas.openxmlformats.org/officeDocument/2006/math"

// What an element holds: other elements, a value (m:val), or text (a run).
const CONTAINER = 0
const VALUE = 1
const RUN = 2

const CONTAINERS = [
	"acc",
	"accPr",
	"argPr",
	"bar",
	"barPr",
	"borderBox",
	"borderBoxPr",
	"box",
	"boxPr",
	"brk",
	"ctrlPr",
	"d",
	"deg",
	"den",
	"dPr",
	"e",
	"eqArr",
	"eqArrPr",
	"f",
	"fName",
	"fPr",
	"func",
	"funcPr",
	"groupChr",
	"groupChrPr",
	"lim",
	"limLow",
	"limLowPr",
	"limUpp",
	"limUppPr",
	"m",
	"mc",
	"mcPr",
	"mcs",
	"mPr",
	"mr",
	"nary",
	"naryPr",
	"num",
	"oMath",
	"oMathPara",
	"oMathParaPr",
	"phant",
	"phantPr",
	"rad",
	"radPr",
	"rPr",
	"sPre",
	"sPrePr",
	"sSub",
	"sSubPr",
	"sSubSup",
	"sSubSupPr",
	"sSup",
	"sSupPr",
	"sub",
	"sup"
]

// Values kept as written (a character may be a space, and an empty one means none).
const CHARACTERS = ["chr", "begChr", "endChr", "sepChr"]
const NAMED = ["type", "limLoc", "pos", "vertJc", "jc", "sty", "scr", "baseJc", "mcJc", "shp"]
const ON_OFF = [
	"degHide",
	"grow",
	"subHide",
	"supHide",
	"noBar",
	"show",
	"hideTop",
	"hideBot",
	"hideLeft",
	"hideRight",
	"strikeH",
	"strikeV",
	"strikeBLTR",
	"strikeTLBR",
	"opEmu",
	"noBreak",
	"diff",
	"zeroWid",
	"zeroAsc",
	"zeroDesc",
	"transp",
	"plcHide",
	"lit",
	"nor",
	"aln",
	"alnScr",
	"maxDist",
	"objDist"
]
const NUMBERS = ["count", "rSp", "rSpRule", "cGp", "cGpRule", "cSp", "argSz"]

const KINDS: ReadonlyMap<string, number> = new Map([
	...CONTAINERS.map(name => [name, CONTAINER] as const),
	...[...CHARACTERS, ...NAMED, ...ON_OFF, ...NUMBERS].map(name => [name, VALUE] as const),
	["r", RUN]
])

const KEPT: ReadonlySet<string> = new Set(CHARACTERS)
const FLAGS: ReadonlySet<string> = new Set(ON_OFF)
const COUNTS: ReadonlySet<string> = new Set(NUMBERS)

// A word's parameter as a property's m:val; undefined where the specification's numbering of a named value is not
// the OOXML name (left at its default).
function parameterValue(name: string, param: number): string | undefined {
	if (FLAGS.has(name)) return param === 0 ? "off" : "on"
	if (COUNTS.has(name)) return String(param)

	return undefined
}

interface Open {
	// The reader's group the element is.
	readonly owner: object | undefined
	readonly name: string
	readonly kind: number
	// A value's or a run's text so far.
	text: string
	// A value given as the word's parameter.
	readonly param: string | undefined
	// A run's w:rPr (its first text's; "" once written).
	props: string | undefined
}

// Builds the Office Math of one \\mmath group as it is read.
export class OmmlBuilder {
	private out = ""
	private readonly open: Open[] = []

	// Whether `name` (a math word without its leading "m") is an element.
	static known(name: string): boolean {
		return KINDS.has(name)
	}

	// A group the element `name` is (its word first in it); `param` the word's parameter.
	begin(name: string, owner: object, param: number | undefined): void {
		const kind = KINDS.get(name) ?? CONTAINER

		if (this.open.length === 0 && name !== "oMath" && name !== "oMathPara") this.implicitMath()

		this.beforeChild()

		if (kind !== VALUE) this.out += this.open.length === 0 ? `<m:${name} xmlns:m="${OMML}">` : `<m:${name}>`

		this.open.push({
			owner,
			name,
			kind,
			text: "",
			param: param === undefined ? undefined : parameterValue(name, param),
			props: undefined
		})
	}

	// The group `owner` ended: its element closes.
	end(owner: object): void {
		const top = this.open.at(-1)

		if (top === undefined || top.owner !== owner) return

		this.open.pop()
		this.close(top)
	}

	// A property word inside another element's group (\\mdegHide1 after \\mradPr): an empty element with its value.
	property(name: string, param: number, hasParam: boolean): void {
		if (KINDS.get(name) !== VALUE) return

		const value = hasParam ? parameterValue(name, param) : undefined

		if (hasParam && value === undefined) return

		this.beforeChild()
		this.out += value === undefined ? `<m:${name}/>` : `<m:${name} m:val="${escapeAttribute(value)}"/>`
	}

	// Decoded text; `props` the w:rPr it is shown with.
	text(text: string, props: string): void {
		const top = this.open.at(-1)

		if (top !== undefined && top.kind !== CONTAINER) {
			if (top.kind === RUN) top.props ??= props

			top.text += text

			return
		}

		// Spaces between groups lay nothing out.
		if (text.trim() === "") return

		if (top === undefined) this.implicitMath()

		this.out += `<m:r>${props}<m:t xml:space="preserve">${escapeText(text)}</m:t></m:r>`
	}

	// The equation's markup, every element closed ("" for none).
	result(): string {
		for (let top = this.open.pop(); top !== undefined; top = this.open.pop()) this.close(top)

		return this.out
	}

	private implicitMath(): void {
		this.out += `<m:oMath xmlns:m="${OMML}">`
		this.open.push({ owner: undefined, name: "oMath", kind: CONTAINER, text: "", param: undefined, props: undefined })
	}

	// A run's text so far is written before an element inside it.
	private beforeChild(): void {
		const top = this.open.at(-1)

		if (top?.kind !== RUN || top.text === "") return

		this.out += runText(top)
		top.text = ""
	}

	private close(element: Open): void {
		switch (element.kind) {
			case VALUE: {
				const value = element.param ?? (KEPT.has(element.name) ? element.text : element.text.trim())

				this.out +=
					value === "" && !KEPT.has(element.name)
						? `<m:${element.name}/>`
						: `<m:${element.name} m:val="${escapeAttribute(value)}"/>`
				break
			}
			case RUN:
				this.out += `${element.text === "" ? "" : runText(element)}</m:r>`
				break
			default:
				this.out += `</m:${element.name}>`
		}
	}
}

function runText(run: Open): string {
	const props = run.props ?? ""

	run.props = ""

	return `${props}<m:t xml:space="preserve">${escapeText(run.text)}</m:t>`
}
