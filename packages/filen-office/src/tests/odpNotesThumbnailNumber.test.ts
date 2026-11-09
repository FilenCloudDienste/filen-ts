import { strFromU8, strToU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { staleThumbnailNumber } from "../core/odp/write/splice"
import type { SlideRef } from "../core/presentation/model"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// A notes page's thumbnail names the page it shows (draw:page-number on draw:page-thumbnail, ODF 1.3 Part 3): a save
// that moves or duplicates pages writes each thumbnail's number as its page's position.

type Drive = Awaited<ReturnType<typeof driveSession>>

function page(name: string, number: number | undefined): string {
	const attribute = number === undefined ? "" : ` draw:page-number="${String(number)}"`

	return (
		`<draw:page draw:name="${name}" draw:master-page-name="M">` +
		`<draw:frame svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>${name}</text:p></draw:text-box></draw:frame>` +
		`<presentation:notes><draw:page-thumbnail svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="7cm"${attribute} presentation:class="page"/>` +
		`<draw:frame presentation:class="notes" svg:x="2cm" svg:y="10cm" svg:width="10cm" svg:height="5cm"><draw:text-box><text:p>Notes ${name}</text:p></draw:text-box></draw:frame>` +
		"</presentation:notes></draw:page>"
	)
}

async function written(d: Drive): Promise<string> {
	const outcome = await d.save()

	if (outcome.result.kind !== "written" || outcome.bytes === undefined) throw new Error(JSON.stringify(outcome.result))

	return strFromU8(unzipSync(outcome.bytes)["content.xml"] as Uint8Array)
}

// Each page's name and its notes thumbnail's page number (undefined without one), in order.
function numbers(content: string): (readonly [string, string | undefined])[] {
	return [...content.matchAll(/<draw:page draw:name="([^"]*)"[\s\S]*?<\/draw:page>/gu)].map(match => [
		match[1] ?? "",
		/<draw:page-thumbnail [^>]*draw:page-number="([^"]*)"/u.exec(match[0])?.[1]
	])
}

describe("notes thumbnail page numbers", () => {
	it("follow a page moved to the front, unparsed pages copied with only the number changed", async () => {
		const d = await driveSession(odpBytes({ body: page("One", 1) + page("Two", 2) + page("Three", 3) }), "odp")
		const third = d.session.deck.slides[2] as SlideRef

		expect((await d.command({ family: "slide", kind: "move", slides: [third], to: 0 })).ok).toBe(true)

		const content = await written(d)

		expect(numbers(content)).toEqual([
			["Three", "1"],
			["One", "2"],
			["Two", "3"]
		])
		expect(content).toContain(page("Three", 1))
		expect(content).toContain(page("One", 2))
	})

	it("give a duplicated page its own position, and the pages after it theirs", async () => {
		const d = await driveSession(odpBytes({ body: page("One", 1) + page("Two", 2) + page("Three", 3) }), "odp")
		const first = d.session.deck.slides[0] as SlideRef

		expect((await d.command({ family: "slide", kind: "duplicate", slide: first })).ok).toBe(true)

		const found = numbers(await written(d))

		expect(found.map(([, number]) => number)).toEqual(["1", "2", "3", "4"])
		expect(found.map(([name]) => name)).toEqual(["One", expect.any(String), "Two", "Three"])
	})

	it("find the number in any prefix and quoting, only on the notes' thumbnail", () => {
		const at = (markup: string, number: number): string | undefined => {
			const bytes = strToU8(markup)
			const patch = staleThumbnailNumber(bytes, 0, bytes.length, number)

			return patch === undefined ? undefined : `${strFromU8(bytes.subarray(0, patch.start))}|${strFromU8(patch.value)}`
		}
		const notes = "<d:page><d:page-thumbnail d:page-number='9'/><p:notes x:notes='a:notes'><t:p>a:notes</t:p>"

		expect(at(`${notes}<d:page-thumbnail a="&gt;>" d:page-number = '2'/></p:notes></d:page>`, 1)).toBe(
			`${notes}<d:page-thumbnail a="&gt;>" d:page-number = '|1`
		)
		expect(at(`${notes}<d:page-thumbnail d:page-number="1"/></p:notes></d:page>`, 1)).toBeUndefined()
		expect(at(`${notes}<d:page-thumbnail e:page-number="2"/></p:notes></d:page>`, 1)).toBeUndefined()
		expect(at("<d:page><d:page-thumbnail d:page-number='9'/></d:page>", 1)).toBeUndefined()
	})

	it("leave a thumbnail without a number, and an unmoved deck, as the file has them", async () => {
		const source = page("One", undefined) + page("Two", 2)
		const d = await driveSession(odpBytes({ body: source }), "odp")
		const second = d.session.deck.slides[1] as SlideRef

		expect((await d.command({ family: "slide", kind: "hide", slides: [second], hidden: true })).ok).toBe(true)

		const content = await written(d)

		expect(numbers(content)).toEqual([
			["One", undefined],
			["Two", "2"]
		])
		expect(content).toContain(page("One", undefined))
	})
})
