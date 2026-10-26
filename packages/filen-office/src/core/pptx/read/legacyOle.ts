import { D, drawingReader } from "../../drawingml/reader"
import type { XmlDocument } from "../../xml/index"

// OLE objects written the PowerPoint 2007 way keep their preview picture in the slide's legacy VML drawing, not in
// the p:oleObj: the object's spid names a v:shape there (by o:spid, else id), whose v:imagedata o:relid is a
// relationship of the VML part (ECMA-376 Part 1 §19.3.1.36 oleObj spid; Part 4 §19.1.2.11 imagedata).

// Shapes looked at in one VML part: legacy drawings hold one shape per control or object.
const MAX_VML_SHAPES = 10_000

// spid → the preview's relationship id in the VML part.
export function legacyOlePreviews(document: XmlDocument): Map<string, string> {
	const out = new Map<string, string>()
	const reader = drawingReader(document)
	let seen = 0

	for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
		if (++seen > MAX_VML_SHAPES) break
		if (!reader.is(node, D.V, "shape")) continue

		const relId = reader.attrNs(reader.child(node, D.V, "imagedata"), D.O, "relid")
		const spid = reader.attrNs(node, D.O, "spid") ?? reader.attr(node, "id")

		if (relId !== undefined && spid !== undefined && !out.has(spid)) out.set(spid, relId)
	}

	return out
}
