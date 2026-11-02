import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { strToU8, unzipSync, zipSync } from "fflate"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { image } from "./presentationObjectsFixtures"

// A picture inserted into a page whose content.xml binds no xlink prefix (the writer's draw:image names its image by
// xlink:href): the frame declares what its markup writes, so it reads back as the picture.

const BOX = {
	x: 1_000_000,
	y: 1_000_000,
	cx: 2_000_000,
	cy: 1_000_000,
	rot: 0,
	flipH: false,
	flipV: false
}
const DECKS = ["lo__tdf163343.odp", "lo__tdf169979.odp"].map(file => join(CORPUS_DIR, "odp", file))

// A content.xml with no xlink declaration on its root.
function bare(): Uint8Array {
	const files = unzipSync(
		odpBytes({
			body: '<draw:page draw:name="P" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T</text:p></draw:text-box></draw:frame></draw:page>'
		})
	)

	files["content.xml"] = strToU8(
		new TextDecoder().decode(files["content.xml"]).replace(' xmlns:xlink="http://www.w3.org/1999/xlink"', "")
	)

	return zipSync(files)
}

async function inserted(bytes: Uint8Array, flipH: boolean): Promise<void> {
	const d = await driveSession(bytes, "odp")
	const slide = d.session.deck.slides[0] as SlideRef

	await review(d.context, slide)

	const shape = {
		id: 0,
		name: "Picture",
		hidden: false,
		kind: "pic",
		xfrm: { ...BOX, flipH }
	} as ShapeNode

	expect(
		(
			await d.command({
				family: "picture",
				kind: "insert",
				slide,
				shape,
				image: image(12, 7)
			})
		).ok
	).toBe(true)

	const saved = await d.save()

	expect(saved.result).toEqual(expect.objectContaining({ kind: "written" }))

	const again = await driveSession(saved.bytes ?? new Uint8Array(0), "odp")
	const first = again.session.deck.slides[0] as SlideRef

	await review(again.context, first)
	expect((again.session.deck.nodes.get(first) as SlideNode).shapes.find(each => each.name === "Picture")?.kind).toBe("pic")
}

describe("a picture inserted into an ODP page whose document binds no xlink", () => {
	for (const flipH of [false, true]) {
		it(`a built page${flipH ? ", mirrored" : ""}: written and read back as the picture`, async () => {
			await inserted(bare(), flipH)
		})

		for (const path of DECKS)
			it.skipIf(!existsSync(path))(
				`${path.split("/").pop() ?? ""}${flipH ? ", mirrored" : ""}: written and read back as the picture`,
				async () => {
					await inserted(new Uint8Array(readFileSync(path)), flipH)
				}
			)
	}
})
