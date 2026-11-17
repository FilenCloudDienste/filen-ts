// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { OFFICE_PDF_FONT_URLS } from "virtual:office-pdf-fonts"
import { fetchOfficePdfFontSync } from "@/features/office/lib/pdfFontAssets"

// The MuPDF read role's synchronous face fetch, over a stand-in XMLHttpRequest.

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubRequest(send: (request: FakeRequest) => void): FakeRequest[] {
	const made: FakeRequest[] = []

	vi.stubGlobal(
		"XMLHttpRequest",
		class extends FakeRequest {
			constructor() {
				super(send)
				made.push(this)
			}
		}
	)

	return made
}

class FakeRequest {
	timeout = 0
	responseType = ""
	status = 0
	response: unknown = null
	readonly opened: unknown[] = []
	private readonly onSend: (request: FakeRequest) => void

	constructor(onSend: (request: FakeRequest) => void) {
		this.onSend = onSend
	}

	open(...args: unknown[]): void {
		this.opened.push(...args)
	}

	send(): void {
		this.onSend(this)
	}
}

const FILE = Object.keys(OFFICE_PDF_FONT_URLS)[0] ?? ""

describe("fetchOfficePdfFontSync", () => {
	it("reads a face synchronously from the app, and gives up on a stalled request", () => {
		const made = stubRequest(request => {
			request.status = 200
			request.response = new Uint8Array([1, 2, 3]).buffer
		})

		expect(Array.from(fetchOfficePdfFontSync(FILE))).toEqual([1, 2, 3])
		expect(made[0]?.opened).toEqual(["GET", OFFICE_PDF_FONT_URLS[FILE], false])
		expect(made[0]?.timeout).toBeGreaterThan(0)

		stubRequest(request => {
			if (request.timeout > 0) throw new DOMException("timed out", "TimeoutError")
		})
		expect(() => fetchOfficePdfFontSync(FILE)).toThrow("timed out")
	})
})
