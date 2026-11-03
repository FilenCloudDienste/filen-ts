import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { PPT_AUTONUMBER_SCHEMES } from "../core/ppt/text"
import { pptToPptx } from "../core/ppt/toPptx"
import { AUTONUMBER_SCHEMES, autonumberText } from "../core/presentation/text/autonum"
import { CORPUS_DIR } from "./corpusDir"

// A .ppt paragraph numbered automatically keeps its numbering: PowerPoint 2000 writes the scheme in the "___PPT9"
// extension (TextPFException9 fBulletHasAutoNumber and bulletAutoNumberScheme), a
// TextAutoNumberSchemeEnum whose order differs from ECMA-376's ST_TextAutonumberScheme.
// lo__tdf77747.ppt numbers two Hebrew paragraphs ANM_Hebrew2Minus (א- ב-), as LibreOffice 7.5 draws them.

const FILE = join(CORPUS_DIR, "ppt/lo__tdf77747.ppt")

describe(".ppt automatic numbering", () => {
	it("maps every TextAutoNumberSchemeEnum value to the ST_TextAutonumberScheme our renderer draws", () => {
		expect(PPT_AUTONUMBER_SCHEMES).toHaveLength(41)
		expect(PPT_AUTONUMBER_SCHEMES[0]).toBe("alphaLcPeriod")
		expect(PPT_AUTONUMBER_SCHEMES[2]).toBe("arabicParenR")
		expect(PPT_AUTONUMBER_SCHEMES[3]).toBe("arabicPeriod")
		expect(PPT_AUTONUMBER_SCHEMES[13]).toBe("arabicPlain")
		expect(PPT_AUTONUMBER_SCHEMES[16]).toBe("ea1ChsPlain")
		expect(PPT_AUTONUMBER_SCHEMES[25]).toBe("hebrew2Minus")
		expect(PPT_AUTONUMBER_SCHEMES[38]).toBe("ea1JpnChsDbPeriod")
		expect(PPT_AUTONUMBER_SCHEMES[40]).toBe("hindiAlpha1Period")
		expect(new Set(PPT_AUTONUMBER_SCHEMES).size).toBe(41)

		for (const scheme of PPT_AUTONUMBER_SCHEMES) expect(AUTONUMBER_SCHEMES).toContain(scheme)

		expect(autonumberText("hebrew2Minus", 1)).toBe("א-")
		expect(autonumberText("hebrew2Minus", 2)).toBe("ב-")
	})

	it.skipIf(!existsSync(FILE))("converts a shape's Hebrew alpha-dash numbering to a:buAutoNum", async () => {
		const converted = await pptToPptx(bytesSource(new Uint8Array(readFileSync(FILE))))

		if (converted.kind !== "converted") throw new Error(JSON.stringify(converted))

		const slide = new TextDecoder().decode(await converted.pptx.read("ppt/slides/slide1.xml"))
		const numbered = slide.match(/<a:buAutoNum type="hebrew2Minus"\/>/gu) ?? []

		expect(numbered).toHaveLength(2)
		expect(slide).not.toContain("<a:buChar")
	})
})
