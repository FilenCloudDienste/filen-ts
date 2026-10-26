import { strToU8, zipSync } from "fflate"

// Small PresentationML packages built in memory for the reader tests: one master with title, body and footer
// placeholders, its layouts, a theme, and the slides a test describes. Every part can be replaced or added.

export const P = "http://schemas.openxmlformats.org/presentationml/2006/main"
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
export const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const CT_PML = "application/vnd.openxmlformats-officedocument.presentationml"

export const THEME =
	`<a:theme xmlns:a="${A}" name="Plain"><a:themeElements>` +
	'<a:clrScheme name="Plain"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
	'<a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
	'<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
	'<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
	'<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
	'<a:fontScheme name="Plain"><a:majorFont><a:latin typeface="Major Face"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="Jpan Major"/></a:majorFont>' +
	'<a:minorFont><a:latin typeface="Minor Face"/><a:ea typeface="Minor EA"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
	'<a:fmtScheme name="Plain"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	'<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
	"</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>" +
	'<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
	'<a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill></a:bgFillStyleLst></a:fmtScheme>' +
	"</a:themeElements></a:theme>"

export const COLOR_MAP =
	'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

export function tree(shapes: string): string {
	return (
		'<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
		`${shapes}</p:spTree></p:cSld>`
	)
}

export function xfrm(x: number, y: number, cx: number, cy: number): string {
	return `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
}

// A p:sp: `ph` is the p:ph attributes ("" for none), `spPr` and `txBody` inner markup.
export function sp(id: number, name: string, ph: string | undefined, spPr = "", txBody?: string, extra = ""): string {
	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"${extra}/><p:cNvSpPr/><p:nvPr>${ph === undefined ? "" : `<p:ph ${ph}/>`}</p:nvPr></p:nvSpPr>` +
		`<p:spPr>${spPr}</p:spPr>${txBody === undefined ? "" : `<p:txBody>${txBody}</p:txBody>`}</p:sp>`
	)
}

export function body(paragraphs: string, bodyPr = "<a:bodyPr/>", lstStyle = "<a:lstStyle/>"): string {
	return `${bodyPr}${lstStyle}${paragraphs}`
}

export function para(text: string, rPr = "", pPr = ""): string {
	return `<a:p>${pPr}<a:r><a:rPr lang="en-GB"${rPr}/><a:t>${text}</a:t></a:r></a:p>`
}

const MASTER_SHAPES =
	sp(2, "Title Placeholder 1", 'type="title"', xfrm(100, 200, 3000, 400), body("", '<a:bodyPr anchor="ctr"/>')) +
	sp(3, "Text Placeholder 2", 'type="body" idx="1"', xfrm(100, 700, 3000, 2000), body("", '<a:bodyPr lIns="12700"/>')) +
	sp(4, "Date Placeholder 3", 'type="dt" sz="half" idx="2"', xfrm(100, 3000, 900, 100)) +
	sp(5, "Footer Placeholder 4", 'type="ftr" sz="quarter" idx="3"', xfrm(1100, 3000, 900, 100)) +
	sp(6, "Slide Number Placeholder 5", 'type="sldNum" sz="quarter" idx="4"', xfrm(2100, 3000, 900, 100)) +
	sp(7, "Master Logo", undefined, xfrm(0, 0, 50, 50))

const MASTER_TX_STYLES =
	"<p:txStyles>" +
	'<p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
	'<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr marL="685800"><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>' +
	'<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>' +
	"</p:txStyles>"

export interface FixtureSlide {
	// The p:sld inner markup after p:cSld (or the whole cSld when it starts with "<p:cSld").
	readonly shapes: string
	readonly layout?: number
	// Root attributes (show="0", showMasterSp="0").
	readonly attributes?: string
	// Markup after p:cSld (p:clrMapOvr, p:transition…).
	readonly after?: string
	// Extra relationships ["rId9", "type", "target"].
	readonly rels?: readonly (readonly [string, string, string, string?])[]
	readonly notes?: string
}

export interface FixtureLayout {
	readonly name: string
	readonly type?: string
	readonly shapes: string
	readonly attributes?: string
}

export interface FixtureOptions {
	readonly slides: readonly FixtureSlide[]
	readonly layouts?: readonly FixtureLayout[]
	// Markup inside p:presentation after p:notesSz (defaultTextStyle, custShowLst, extLst, modifyVerifier).
	readonly presentation?: string
	readonly presentationAttributes?: string
	readonly presentationRels?: readonly (readonly [string, string, string, string?])[]
	readonly mainContentType?: string
	readonly sldSz?: string
	// Extra parts: name → text or bytes, with a content type override.
	readonly parts?: Readonly<Record<string, { readonly data: string | Uint8Array; readonly type?: string }>>
	readonly packageRels?: readonly (readonly [string, string, string])[]
	readonly defaults?: string
	readonly master?: string
	readonly masterAfter?: string
	readonly notesMaster?: string
}

function rels(entries: readonly (readonly [string, string, string, string?])[]): string {
	return (
		`${XML}<Relationships xmlns="${RELS}">` +
		entries
			.map(
				([id, type, target, mode]) =>
					`<Relationship Id="${id}" Type="${type.includes("://") ? type : `${R}/${type}`}" Target="${target}"${mode === undefined ? "" : ` TargetMode="${mode}"`}/>`
			)
			.join("") +
		"</Relationships>"
	)
}

export const DEFAULT_LAYOUTS: readonly FixtureLayout[] = [
	{
		name: "Title and Content",
		type: "obj",
		shapes:
			sp(2, "Title 1", 'type="title"') +
			sp(
				3,
				"Content Placeholder 2",
				'idx="1"',
				xfrm(150, 750, 2900, 1900),
				body("", '<a:bodyPr tIns="0"/>', '<a:lstStyle><a:lvl1pPr><a:defRPr sz="2600"/></a:lvl1pPr></a:lstStyle>')
			) +
			sp(4, "Layout Line", undefined, xfrm(0, 100, 50, 5))
	},
	{
		name: "Blank",
		type: "blank",
		shapes: sp(2, "Date Placeholder 1", 'type="dt" sz="half" idx="10"')
	}
]

export function buildPptx(options: FixtureOptions): Uint8Array {
	const layouts = options.layouts ?? DEFAULT_LAYOUTS
	const files: Record<string, string | Uint8Array> = {}
	const overrides: string[] = []
	const override = (part: string, type: string): void => {
		overrides.push(`<Override PartName="/${part}" ContentType="${type}"/>`)
	}

	override("ppt/presentation.xml", options.mainContentType ?? `${CT_PML}.presentation.main+xml`)
	override("ppt/slideMasters/slideMaster1.xml", `${CT_PML}.slideMaster+xml`)
	override("ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml")

	const presentationRels: (readonly [string, string, string, string?])[] = [
		["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
		["rId2", "theme", "theme/theme1.xml"]
	]
	const slideIds: string[] = []

	options.slides.forEach((slide, index) => {
		const n = index + 1
		const part = `ppt/slides/slide${n}.xml`
		const cSld = slide.shapes.startsWith("<p:cSld") ? slide.shapes : tree(slide.shapes)
		const slideRels: (readonly [string, string, string, string?])[] = [
			["rId1", "slideLayout", `../slideLayouts/slideLayout${slide.layout ?? 1}.xml`],
			...(slide.rels ?? [])
		]

		files[part] = `${XML}<p:sld ${NS}${slide.attributes ?? ""}>${cSld}${slide.after ?? ""}</p:sld>`
		override(part, `${CT_PML}.slide+xml`)
		presentationRels.push([`rId${100 + n}`, "slide", `slides/slide${n}.xml`])
		slideIds.push(`<p:sldId id="${255 + n}" r:id="rId${100 + n}"/>`)

		if (slide.notes !== undefined) {
			const notesPart = `ppt/notesSlides/notesSlide${n}.xml`

			files[notesPart] =
				`${XML}<p:notes ${NS}>${tree(sp(2, "Slide Image Placeholder 1", 'type="sldImg"') + sp(3, "Notes Placeholder 2", 'type="body" idx="1"', "", body(slide.notes)))}</p:notes>`
			files[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = rels([
				["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
				["rId2", "slide", `../slides/slide${n}.xml`]
			])
			override(notesPart, `${CT_PML}.notesSlide+xml`)
			slideRels.push(["rId90", "notesSlide", `../notesSlides/notesSlide${n}.xml`])
		}

		files[`ppt/slides/_rels/slide${n}.xml.rels`] = rels(slideRels)
	})

	const hasNotes = options.slides.some(slide => slide.notes !== undefined)

	if (hasNotes) {
		files["ppt/notesMasters/notesMaster1.xml"] =
			options.notesMaster ??
			`${XML}<p:notesMaster ${NS}>${tree(sp(2, "Notes Placeholder 1", 'type="body" idx="1"', xfrm(10, 20, 300, 400)) + sp(3, "Slide Number", 'type="sldNum" idx="5"', xfrm(10, 500, 30, 10)))}<p:clrMap ${COLOR_MAP}/><p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle></p:notesMaster>`
		files["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = rels([["rId1", "theme", "../theme/theme1.xml"]])
		override("ppt/notesMasters/notesMaster1.xml", `${CT_PML}.notesMaster+xml`)
		presentationRels.push(["rId3", "notesMaster", "notesMasters/notesMaster1.xml"])
	}

	layouts.forEach((layout, index) => {
		const n = index + 1
		const part = `ppt/slideLayouts/slideLayout${n}.xml`

		files[part] =
			`${XML}<p:sldLayout ${NS}${layout.type === undefined ? "" : ` type="${layout.type}"`}${layout.attributes ?? ""}>` +
			`${tree(layout.shapes).replace("<p:cSld>", `<p:cSld name="${layout.name}">`)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
		files[`ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`] = rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])
		override(part, `${CT_PML}.slideLayout+xml`)
	})

	files["ppt/slideMasters/slideMaster1.xml"] =
		`${XML}<p:sldMaster ${NS}>${options.master ?? tree(MASTER_SHAPES).replace("<p:cSld>", '<p:cSld name="Office Theme"><p:bg><p:bgRef idx="1002"><a:schemeClr val="bg1"/></p:bgRef></p:bg>')}` +
		`<p:clrMap ${COLOR_MAP}/><p:sldLayoutIdLst>${layouts.map((_, index) => `<p:sldLayoutId id="${2147483649 + index}" r:id="rId${index + 1}"/>`).join("")}</p:sldLayoutIdLst>` +
		`${options.masterAfter ?? MASTER_TX_STYLES}</p:sldMaster>`
	files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = rels([
		...layouts.map((_, index) => [`rId${index + 1}`, "slideLayout", `../slideLayouts/slideLayout${index + 1}.xml`] as const),
		["rId99", "theme", "../theme/theme1.xml"]
	])
	files["ppt/theme/theme1.xml"] = `${XML}${THEME}`
	files["ppt/presentation.xml"] =
		`${XML}<p:presentation ${NS}${options.presentationAttributes ?? ""}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
		(hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst>' : "") +
		`<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>${options.sldSz ?? '<p:sldSz cx="12192000" cy="6858000"/>'}<p:notesSz cx="6858000" cy="9144000"/>` +
		`${options.presentation ?? ""}</p:presentation>`
	files["ppt/_rels/presentation.xml.rels"] = rels([...presentationRels, ...(options.presentationRels ?? [])])

	for (const [name, part] of Object.entries(options.parts ?? {})) {
		files[name] = part.data
		if (part.type !== undefined) override(name, part.type)
	}

	files["_rels/.rels"] = rels([["rId1", "officeDocument", "ppt/presentation.xml"], ...(options.packageRels ?? [])])
	files["[Content_Types].xml"] =
		`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
		`${options.defaults ?? ""}${overrides.join("")}</Types>`

	return zipSync(
		Object.fromEntries(
			Object.entries(files).map(([path, data]) => [
				path,
				[typeof data === "string" ? strToU8(data) : data, { mtime: new Date(2020, 0, 1) }]
			])
		)
	)
}
