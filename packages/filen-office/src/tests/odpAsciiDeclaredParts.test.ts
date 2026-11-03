import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { utf8Declared } from "../core/odp/write/splice"
import type { SlideRef, TextBody } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// A part declared encoding='us-ascii' (as some writers declare an all-ASCII stream) that a save gives text past ASCII
// is declared UTF-8, the encoding its bytes are in; one that stays ASCII keeps its declaration and bytes.

function asciiDeclared(): Uint8Array {
	const files = unzipSync(
		odpBytes({
			body: '<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T</text:p></draw:text-box></draw:frame></draw:page>'
		})
	)

	for (const name of ["content.xml", "styles.xml"])
		files[name] = strToU8(strFromU8(files[name] as Uint8Array).replace('encoding="UTF-8"', "encoding='us-ascii'"))

	return zipSync(files)
}

const typed = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })

describe("an ODP part declared us-ascii", () => {
	it("given text past ASCII by a save: declared UTF-8, and reads back as typed", async () => {
		const d = await driveSession(asciiDeclared(), "odp")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		const shape = d.session.deck.nodes.get(slide)?.shapes[0]

		expect(
			(await d.command({ family: "text", kind: "setText", target: { slide, id: shape?.id as number }, body: typed("Café • ☃") })).ok
		).toBe(true)

		const saved = await d.save()
		const content = strFromU8(unzipSync(saved.bytes as Uint8Array)["content.xml"] as Uint8Array)

		expect(content.slice(0, 60)).toMatch(/^<\?xml version="1\.0" encoding='UTF-8'\?>/u)
		expect(content).toContain("Café • ☃")
	})

	it("kept as written while it holds ASCII only", () => {
		const ascii = strToU8("<?xml version=\"1.0\" encoding='us-ascii'?><a>b</a>")

		expect(utf8Declared(ascii)).toBe(ascii)
		expect(strFromU8(utf8Declared(strToU8('<?xml version="1.0" encoding="US-ASCII"?><a>é</a>')))).toBe(
			'<?xml version="1.0" encoding="UTF-8"?><a>é</a>'
		)
		expect(strFromU8(utf8Declared(strToU8('<?xml version="1.0" encoding="UTF-8"?><a>é</a>')))).toBe(
			'<?xml version="1.0" encoding="UTF-8"?><a>é</a>'
		)
	})
})
