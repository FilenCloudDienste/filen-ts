import type { PlaceholderType, SlideNode } from "../../presentation/model"

// The ST_SlideLayoutType (ECMA-376 Part 1 §19.7.15) of a layout synthesized from an ODP presentation page layout
// (§16.43), whose layoutType is the page layout's style:name: by its placeholders, as LibreOffice tells its AutoLayouts
// apart (title and subtitle: a title slide; title and one, two or four contents; title only; none: blank). A layout
// without placeholders goes by LibreOffice's "AL<n>T<AutoLayout>" naming when its name follows it, else is blank.

const CONTENT: ReadonlySet<PlaceholderType> = new Set(["body", "obj", "chart", "tbl", "pic", "dgm", "media", "clipArt"])

// LibreOffice AutoLayout ids (AUTOLAYOUT_TITLE, _TITLE_CONTENT, _TITLE_2CONTENT, _TITLE_ONLY, _NONE).
const AUTOLAYOUT_TYPES: Readonly<Record<string, string>> = { "0": "title", "1": "obj", "3": "twoObj", "19": "titleOnly", "20": "blank" }

export function odpLayoutType(layout: Pick<SlideNode, "layoutType" | "shapes">): string | undefined {
	let title = false
	let subtitle = false
	let contents = 0
	let placeholders = 0

	for (const shape of layout.shapes) {
		const type = shape.ph?.type

		if (type === undefined || type === "dt" || type === "ftr" || type === "sldNum" || type === "hdr") continue

		placeholders++

		if (type === "title" || type === "ctrTitle") title = true
		else if (type === "subTitle") subtitle = true
		else if (CONTENT.has(type)) contents++
	}

	if (placeholders === 0) {
		const autoLayout = /^AL\d+T(\d+)$/u.exec(layout.layoutType ?? "")?.[1]

		return autoLayout === undefined ? "blank" : AUTOLAYOUT_TYPES[autoLayout]
	}

	if (!title) return undefined
	if (subtitle) return "title"

	return contents === 0 ? "titleOnly" : contents === 1 ? "obj" : contents === 2 ? "twoObj" : contents === 4 ? "fourObj" : undefined
}
