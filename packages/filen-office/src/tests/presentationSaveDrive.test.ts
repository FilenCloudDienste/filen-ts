import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SlideRef } from "../core/presentation/model"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// The test drive saves as the page does: a save with nothing to write opens no upload (one left open aborts at its
// stall, rejecting with nobody to hear it), and a written save's upload makes the file.

const rejected: unknown[] = []
const hear = (reason: unknown): void => {
	rejected.push(reason)
}

beforeEach(() => {
	rejected.length = 0
	process.on("unhandledRejection", hear)
})

afterEach(() => {
	process.off("unhandledRejection", hear)
})

// The upload's stall, short: an upload left open would abort within the test.
const STALL_MS = 10

// Past the stall, and long enough for a rejection nobody handles to be reported.
function turns(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, STALL_MS * 5))
}

function deck(): Uint8Array {
	return buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("S"))) }] })
}

describe("the test drive's saves", () => {
	it("a save with nothing to write leaves no rejection unhandled", async () => {
		const d = await driveSession(deck(), "pptx", [], { stallMs: STALL_MS })

		expect((await d.save()).result.kind).toBe("unchanged")
		await turns()
		expect(rejected).toEqual([])
	})

	it("a written save, then one with nothing new: the first writes, neither leaves a rejection unhandled", async () => {
		const d = await driveSession(deck(), "pptx", [], { stallMs: STALL_MS })
		const slide = d.session.deck.slides[0] as SlideRef

		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.save()).result.kind).toBe("unchanged")
		await turns()
		expect(rejected).toEqual([])
	})
})
