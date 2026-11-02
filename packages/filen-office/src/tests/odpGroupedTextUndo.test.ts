import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// The text of a shape inside a group edited, saved, then undone: the undo puts the shape back from the markup it held,
// which the saved page does not have, so the save writes the group again with it (the state the source had), and a
// redo saves the edit again.

type Drive = Awaited<ReturnType<typeof driveSession>>

const GROUP =
	'<draw:g draw:name="Group"><draw:custom-shape draw:name="A" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><text:p>Alpha</text:p><draw:enhanced-geometry draw:type="rectangle" svg:viewBox="0 0 21600 21600"/></draw:custom-shape>' +
	'<draw:custom-shape draw:name="B" svg:x="6cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><text:p>Beta</text:p><draw:enhanced-geometry draw:type="rectangle" svg:viewBox="0 0 21600 21600"/></draw:custom-shape></draw:g>'

function groupDeck(): Uint8Array {
	return odpBytes({ body: `<draw:page draw:name="One" draw:master-page-name="M">${GROUP}</draw:page>` })
}

async function opened(): Promise<{ d: Drive; slide: SlideRef; group: () => ShapeNode }> {
	const d = await driveSession(groupDeck(), "odp")
	const slide = d.session.deck.slides[0] as SlideRef

	await review(d.context, slide)

	return {
		d,
		slide,
		group: () => (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.name === "Group") as ShapeNode
	}
}

function content(bytes: Uint8Array | undefined): string {
	return strFromU8(unzipSync(bytes ?? new Uint8Array())["content.xml"] ?? new Uint8Array())
}

async function textsIn(bytes: Uint8Array | undefined): Promise<string[]> {
	if (bytes === undefined) throw new Error("no saved file")

	const d = await driveSession(bytes, "odp")
	const slide = d.session.deck.slides[0] as SlideRef

	await review(d.context, slide)

	const group = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.name === "Group")

	return (group?.children ?? []).map(
		child => child.text?.paragraphs.map(p => p.runs.map(run => ("text" in run ? run.text : "")).join("")).join("/") ?? ""
	)
}

describe("a grouped shape's text edited, saved and undone", () => {
	it("saves the undone state and then the redone one", async () => {
		const { d, slide, group } = await opened()
		const child = group().children?.[1] as ShapeNode
		const body = structuredClone(child.text) as TextBody
		const run = body.paragraphs[0]?.runs[0] as { text: string }

		run.text = "Beta edited"
		expect((await d.command({ family: "text", kind: "setText", target: { slide, id: child.id }, body })).ok).toBe(true)

		const edited = await d.save()

		expect(edited.result.kind).toBe("written")
		expect(await textsIn(edited.bytes)).toEqual(["Alpha", "Beta edited"])
		expect((await d.undo()).ok).toBe(true)

		const undone = await d.save()

		expect(undone.result.kind).toBe("written")
		expect(await textsIn(undone.bytes)).toEqual(["Alpha", "Beta"])
		// The undone state is the source's: its content.xml as the source has it.
		expect(content(undone.bytes)).toBe(content(groupDeck()))
		expect((await d.redo()).ok).toBe(true)

		const redone = await d.save()

		expect(redone.result.kind).toBe("written")
		expect(await textsIn(redone.bytes)).toEqual(["Alpha", "Beta edited"])
	})
})

describe("a grouped shape moved", () => {
	it("leaves the group's box the bounds of its members, as the file reads back", async () => {
		const { d, slide, group } = await opened()
		const child = group().children?.[1] as ShapeNode
		const box = child.xfrm as Xfrm
		const before = group().xfrm as Xfrm

		expect(
			(
				await d.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide, id: child.id },
					xfrm: { ...box, x: box.x + 360_000, cx: box.cx + 180_000 }
				})
			).ok
		).toBe(true)

		const moved = group().xfrm as Xfrm

		expect(moved.cx).toBe(before.cx + 540_000)

		const saved = await d.save()
		const reopened = await driveSession(saved.bytes as Uint8Array, "odp")
		const again = reopened.session.deck.slides[0] as SlideRef

		await review(reopened.context, again)

		const read = (reopened.session.deck.nodes.get(again) as SlideNode).shapes.find(shape => shape.name === "Group")?.xfrm

		expect(moved).toEqual(read)

		// Undone, the group is as it was.
		expect((await d.undo()).ok).toBe(true)
		expect(group().xfrm).toEqual(before)
	})
})

describe("a moved or resized group's member moved", () => {
	it.each([
		["moved", (box: Xfrm): Xfrm => ({ ...box, x: box.x + 720_000 })],
		["resized", (box: Xfrm): Xfrm => ({ ...box, cx: box.cx * 2, cy: box.cy + 360_000 })]
	])("%s: leaves the group's box where its members are, as the file reads back", async (_, change) => {
		const { d, slide, group } = await opened()
		const box = group().xfrm as Xfrm

		expect((await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: group().id }, xfrm: change(box) })).ok).toBe(true)

		const child = group().children?.[1] as ShapeNode
		const own = child.xfrm as Xfrm

		expect(
			(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: child.id }, xfrm: { ...own, x: own.x + 360_000 } }))
				.ok
		).toBe(true)

		const moved = group().xfrm as Xfrm
		const saved = await d.save()
		const reopened = await driveSession(saved.bytes as Uint8Array, "odp")
		const again = reopened.session.deck.slides[0] as SlideRef

		await review(reopened.context, again)

		const read = (reopened.session.deck.nodes.get(again) as SlideNode).shapes.find(shape => shape.name === "Group")?.xfrm as Xfrm

		// Within the file's length precision (its lengths in cm to five places: under 4 EMU).
		for (const field of ["x", "y", "cx", "cy"] as const) expect(Math.abs(moved[field] - read[field])).toBeLessThanOrEqual(4)
	})
})

describe("a group with a turned member resized, then the member moved", () => {
	it("leaves the group's box where its members are drawn, as the file reads back", async () => {
		const { d, slide, group } = await opened()
		const member = group().children?.[1] as ShapeNode
		const own = member.xfrm as Xfrm

		expect(
			(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: member.id }, xfrm: { ...own, rot: 30 * 60_000 } })).ok
		).toBe(true)

		const box = group().xfrm as Xfrm

		expect(
			(
				await d.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide, id: group().id },
					xfrm: { ...box, cx: box.cx * 2, cy: box.cy + 720_000 }
				})
			).ok
		).toBe(true)

		const turned = group().children?.[1]?.xfrm as Xfrm

		expect(
			(
				await d.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide, id: member.id },
					xfrm: { ...turned, x: turned.x + 360_000 }
				})
			).ok
		).toBe(true)

		const moved = group().xfrm as Xfrm
		const saved = await d.save()
		const reopened = await driveSession(saved.bytes as Uint8Array, "odp")
		const again = reopened.session.deck.slides[0] as SlideRef

		await review(reopened.context, again)

		const read = (reopened.session.deck.nodes.get(again) as SlideNode).shapes.find(shape => shape.name === "Group")?.xfrm as Xfrm

		for (const field of ["x", "y", "cx", "cy"] as const) expect(Math.abs(moved[field] - read[field])).toBeLessThanOrEqual(4)
	})
})
