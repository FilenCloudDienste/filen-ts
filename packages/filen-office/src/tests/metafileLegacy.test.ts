import { describe, expect, it } from "vitest"
import { convertPresentationMetafile } from "../core/metafile/legacy"

// The pictures only presentations hold (ODF's StarView previews, the Mac PICT blips of .ppt files) convert through
// their own entry, so the editors that never meet them do not load their players.

const SVM = Uint8Array.from([
	...new TextEncoder().encode("VCLMTF"),
	// VersionCompat 1, length 45: compression 0, map mode (1/100 mm, origin 0, scale 1), 2540 x 2540, no actions.
	1,
	0,
	45,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	1,
	0,
	27,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	1,
	0,
	0,
	0,
	0,
	0xec,
	9,
	0,
	0,
	0xec,
	9,
	0,
	0,
	0,
	0,
	0,
	0
])
// picSize, picFrame 0,0,72,72, version 2, standard header, end.
const PICT = Uint8Array.from([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	72,
	0,
	72,
	0,
	0x11,
	2,
	0xff,
	0x0c,
	0,
	0xff,
	0xff,
	0xff,
	0xff,
	...new Array<number>(16).fill(0),
	0,
	0,
	0,
	0,
	0,
	0xff
])

describe("presentation metafiles", () => {
	it("converts StarView and QuickDraw pictures, and EMF and WMF as the shared converter does", () => {
		expect(convertPresentationMetafile(SVM)).toMatchObject({ ok: true, format: "svm", frame: [0, 0, 96, 96] })
		expect(convertPresentationMetafile(PICT)).toMatchObject({ ok: true, format: "pict", frame: [0, 0, 96, 96] })
		expect(convertPresentationMetafile(new Uint8Array(64))).toEqual({ ok: false, reason: "malformed" })
	})
})
