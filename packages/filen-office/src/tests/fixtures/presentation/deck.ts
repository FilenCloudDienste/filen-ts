import {
	slideRef,
	type Deck,
	type ListStyle,
	type ShapeNode,
	type SlideNode,
	type SlideRef,
	type TextBody
} from "../../../core/presentation/model"

// A deck as a reader builds it, without a package: one master, one layout (Title and Content) and `slideCount`
// slides, each with a title placeholder, a body placeholder, a picture and a table. Every slide is parsed (nodes are
// present); refs are master 1, layout 2, slides from 10 on. The deck is new on every call, so tests may mutate it.

export const FIXTURE_MASTER = slideRef(1)
export const FIXTURE_LAYOUT = slideRef(2)
export const FIXTURE_FIRST_SLIDE = 10

const EMPTY_LIST: ListStyle = { levels: [] }

export function fixtureBody(paragraphs: readonly string[]): TextBody {
	return {
		bodyPr: {},
		paragraphs: paragraphs.map(text => ({ pPr: {}, runs: [{ kind: "r", text, rPr: { lang: "en-GB" } }] }))
	}
}

function placeholder(id: number, type: "title" | "body", idx: number, text: TextBody | undefined): ShapeNode {
	return {
		id,
		name: type === "title" ? "Title 1" : "Content Placeholder 2",
		hidden: false,
		kind: "sp",
		ph: { type, idx },
		...(text === undefined ? {} : { text })
	}
}

function slideShapes(index: number): ShapeNode[] {
	return [
		placeholder(2, "title", 0, fixtureBody([`Slide ${String(index + 1)}`])),
		placeholder(3, "body", 1, fixtureBody(["First point", "Second point"])),
		{
			id: 4,
			name: "Picture 3",
			alt: { descr: "A chart of the quarter" },
			hidden: false,
			kind: "pic",
			xfrm: { x: 6_096_000, y: 1_825_625, cx: 2_743_200, cy: 2_057_400, rot: 0, flipH: false, flipV: false },
			props: { fill: { kind: "picture", part: "/ppt/media/image1.png" } }
		},
		{
			id: 5,
			name: "Table 4",
			hidden: false,
			kind: "frame",
			xfrm: { x: 838_200, y: 4_500_000, cx: 4_800_000, cy: 740_000, rot: 0, flipH: false, flipV: false },
			frame: {
				kind: "table",
				table: {
					grid: [2_400_000, 2_400_000],
					rows: [
						{ h: 370_000, cells: [{ text: fixtureBody(["Region"]) }, { text: fixtureBody(["Total"]) }] },
						{ h: 370_000, cells: [{ text: fixtureBody(["North"]) }, { text: fixtureBody(["42"]) }] }
					],
					styleId: "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
					flags: { firstRow: true, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: false }
				}
			}
		}
	]
}

function node(ref: SlideRef, kind: SlideNode["kind"], part: string, shapes: ShapeNode[], extra: Partial<SlideNode> = {}): SlideNode {
	return { ref, kind, part, showMasterShapes: true, hidden: false, shapes, comments: [], revision: 0, ...extra }
}

export function fixtureDeck(slideCount = 3): Deck {
	const nodes = new Map<SlideRef, SlideNode>()
	const slides: SlideRef[] = []

	nodes.set(
		FIXTURE_MASTER,
		node(
			FIXTURE_MASTER,
			"master",
			"/ppt/slideMasters/slideMaster1.xml",
			[
				{
					...placeholder(2, "title", 0, undefined),
					xfrm: { x: 838_200, y: 365_125, cx: 10_515_600, cy: 1_325_563, rot: 0, flipH: false, flipV: false }
				},
				{
					...placeholder(3, "body", 1, undefined),
					xfrm: { x: 838_200, y: 1_825_625, cx: 10_515_600, cy: 4_351_338, rot: 0, flipH: false, flipV: false }
				}
			],
			{
				name: "Office Theme",
				theme: { part: "/ppt/theme/theme1.xml", revision: 0 },
				clrMap: {
					bg1: "lt1",
					tx1: "dk1",
					bg2: "lt2",
					tx2: "dk2",
					accent1: "accent1",
					accent2: "accent2",
					accent3: "accent3",
					accent4: "accent4",
					accent5: "accent5",
					accent6: "accent6",
					hlink: "hlink",
					folHlink: "folHlink"
				},
				background: { kind: "fill", fill: { kind: "solid", color: { kind: "scheme", slot: "bg1" } } },
				txStyles: { title: EMPTY_LIST, body: EMPTY_LIST, other: EMPTY_LIST }
			}
		)
	)
	nodes.set(
		FIXTURE_LAYOUT,
		node(
			FIXTURE_LAYOUT,
			"layout",
			"/ppt/slideLayouts/slideLayout2.xml",
			[placeholder(2, "title", 0, undefined), placeholder(3, "body", 1, undefined)],
			{
				name: "Title and Content",
				layoutType: "obj",
				parent: FIXTURE_MASTER,
				clrMapOvr: "master"
			}
		)
	)

	for (let index = 0; index < slideCount; index++) {
		const ref = slideRef(FIXTURE_FIRST_SLIDE + index)

		slides.push(ref)
		nodes.set(
			ref,
			node(ref, "slide", `/ppt/slides/slide${String(index + 1)}.xml`, slideShapes(index), {
				parent: FIXTURE_LAYOUT,
				clrMapOvr: "master",
				hidden: index === 1
			})
		)
	}

	return {
		format: "pptx",
		variant: "pptx",
		size: { cx: 12_192_000, cy: 6_858_000 },
		notesSize: { cx: 6_858_000, cy: 9_144_000 },
		firstSlideNumber: 1,
		slides,
		masters: [FIXTURE_MASTER],
		layouts: [FIXTURE_LAYOUT],
		nodes,
		sections: slideCount === 0 ? [] : [{ name: "Default Section", id: "{2D4C3F0E-1A6B-4C5D-9E8F-0A1B2C3D4E5F}", slides: [...slides] }],
		customShows: [],
		show: { kind: "present", loop: false, showNarration: true, showAnimation: true, useTimings: true, range: { kind: "all" } },
		defaultTextStyle: EMPTY_LIST,
		embeddedFonts: [],
		protection: {},
		gate: [],
		authors: [],
		opaque: [],
		revision: 0
	}
}
