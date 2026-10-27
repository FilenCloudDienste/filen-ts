// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { SlideRender } from "../core/presentation/output"
import { PICTURE_BULLET_OBJECT } from "../core/presentation/text/page"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { paintSlide, releaseSlidePictures } from "../react/presentation/paint/slide"
import { fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { fixtureTextPage } from "./fixtures/presentation/textPage"
import { paintSlideCanvas, slideImages } from "../dom/presentation/thumbs"
import { RecordingCanvas } from "./presentationCanvasRecorder"

// A text page's picture bullets are painted as their object boxes showing the picture the session serves for the
// page's images entry, once it arrives.

describe("picture bullets painted", () => {
	it("shows each picture bullet's picture in its object box once the session serves it", async () => {
		const base = fixtureTextPage(["One"])
		const text = {
			...base,
			page: {
				...base.page,
				objectCount: 1,
				objectFloats: Float32Array.from([0, 2, 20, 20]),
				objectInts: Int32Array.from([0, 1, 0]),
				objectKinds: Uint8Array.from([PICTURE_BULLET_OBJECT])
			},
			images: ["/ppt/media/image1.png"]
		}
		const fixture = fixtureSlideRender(fixtureDeck(), 0)
		const render = { ...fixture, layers: [{ ...fixture.layers[0], text }] } as unknown as SlideRender
		const asked: string[] = []
		const api = {
			image: (part: string) => {
				asked.push(part)

				return Promise.resolve({ bytes: new Uint8Array([137, 80, 78, 71]), type: "image/png" })
			}
		} as unknown as PresentationSessionApi

		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture/bullet")
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

		const painted = paintSlide(render, { document, session: api, signal: { aborted: false } })

		for (let k = 0; k < 5; k++) await Promise.resolve()

		const box = painted.root.querySelector<HTMLElement>(".fo-docx-object")

		expect(asked).toEqual(["/ppt/media/image1.png"])
		expect(box?.style.background).toContain("blob:fixture/bullet")

		painted.release()
		releaseSlidePictures(api)
	})
})

describe("picture bullets on a canvas", () => {
	it("decodes a picture bullet's part with the slide's pictures and draws it over its place", () => {
		const base = fixtureTextPage(["One"])
		const text = {
			...base,
			page: {
				...base.page,
				objectCount: 1,
				objectFloats: Float32Array.from([4, 2, 20, 20]),
				objectInts: Int32Array.from([0, 1, 0]),
				objectKinds: Uint8Array.from([PICTURE_BULLET_OBJECT])
			},
			images: ["/ppt/media/image1.png"]
		}
		const fixture = fixtureSlideRender(fixtureDeck(), 0)
		const render = { ...fixture, layers: [{ ...fixture.layers[0], text }] } as unknown as SlideRender
		const ctx = new RecordingCanvas(192, 108)

		expect(slideImages(render).map(image => [image.partName, image.format])).toContainEqual(["/ppt/media/image1.png", "png"])

		paintSlideCanvas(ctx, render, 1, {
			image: image =>
				image.partName === "/ppt/media/image1.png" ? { width: 8, height: 8, name: "bullet", close: () => undefined } : undefined
		})

		expect(ctx.calls.filter(call => call.op === "drawImage").map(call => call.args)).toContainEqual(["bullet", 4, 2, 20, 20])
	})
})
