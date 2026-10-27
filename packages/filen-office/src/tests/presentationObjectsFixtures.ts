import { body, buildPptx, para, sp } from "./pptxFixtures"
import type { InsertedImage } from "../core/presentation/edit/ops"

// Decks with tables and pictures for the object edit tests, and an inserted image.

// A 2 × 1 PNG (IHDR only is enough for the size checks; the bytes are stored as they are).
export function png(width = 2, height = 1): Uint8Array {
	const bytes = new Uint8Array(33)

	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	new DataView(bytes.buffer).setUint32(16, width)
	new DataView(bytes.buffer).setUint32(20, height)
	bytes.set([8, 6, 0, 0, 0], 24)

	return bytes
}

export function image(width = 2, height = 1): InsertedImage {
	return { bytes: png(width, height), contentType: "image/png", width, height }
}

const PIC =
	'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3" descr="A cat"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
	'<p:blipFill><a:blip r:embed="rId9"><a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"><a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
	'<p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="2000" cy="1000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

export function pictureDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Pictures"))) + PIC,
				rels: [["rId9", "image", "../media/image1.png"]]
			}
		],
		parts: { "ppt/media/image1.png": { data: png(), type: "image/png" } }
	})
}

function cell(textValue: string, extra = "", tcPr = "<a:tcPr/>"): string {
	return `<a:tc${extra}><a:txBody><a:bodyPr/><a:lstStyle/>${textValue === "" ? '<a:p><a:endParaRPr lang="en-GB"/></a:p>' : para(textValue)}</a:txBody>${tcPr}</a:tc>`
}

export function tableFrame(id: number, rows: readonly (readonly string[])[], merge = ""): string {
	const cols = rows[0]?.length ?? 0
	const grid = Array.from(
		{ length: cols },
		(_, k) =>
			`<a:gridCol w="1000"><a:extLst><a:ext uri="{9D8B030D-6E8A-4147-A177-3AD203B41FA5}"><a16:colId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="${String(100 + k)}"/></a:ext></a:extLst></a:gridCol>`
	).join("")
	const trs = rows
		.map(
			(row, r) =>
				`<a:tr h="400">${row
					.map((value, c) =>
						merge !== "" && r === 0 && c === 0
							? cell(value, merge)
							: merge !== "" && r === 0 && c === 1
								? cell(value, ' hMerge="1"')
								: cell(value)
					)
					.join("")}</a:tr>`
		)
		.join("")

	return (
		`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${String(id)}" name="Table ${String(id)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
		`<p:xfrm><a:off x="100" y="200"/><a:ext cx="${String(cols * 1000)}" cy="${String(rows.length * 400)}"/></p:xfrm>` +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>' +
		`<a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
	)
}

export function tableDeck(merge = ""): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("Tables"))) +
					tableFrame(
						3,
						[
							["A1", "B1", "C1"],
							["A2", "B2", "C2"]
						],
						merge
					)
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Other"))) }
		]
	})
}
