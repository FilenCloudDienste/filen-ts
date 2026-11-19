import { describe, expect, it } from "vitest"
import { unzipSync, strFromU8 } from "fflate"
import { blankDocx } from "../core/templates/docx"
import { conversionSteps } from "../dom/docx/convert"
import { odtBytes } from "./odtFixtures"
import { latin1 } from "./rtfWriteFixtures"
import { workerHarness } from "./docxEncryptedFixtures"

// Text documents converted in the docx worker, as the web's Download as does: the page hands over a copy and gets the
// converted file back transferred, with what it could not keep; a conversion with no direct path goes through .docx;
// the page's signal ends the job.

function part(bytes: Uint8Array, name: string): string {
	const data = unzipSync(bytes)[name]

	if (data === undefined) throw new Error(`No part ${name}`)

	return strFromU8(data)
}

const RTF = latin1("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}\\pard\\plain Hello from RTF.\\par}")

describe("conversionSteps", () => {
	it("goes direct where the converter can and through .docx to .odt where it cannot", () => {
		expect(conversionSteps("docx", "odt")).toEqual([["docx", "odt"]])
		expect(conversionSteps("odt", "docx")).toEqual([["odt", "docx"]])
		expect(conversionSteps("rtf", "odt")).toEqual([
			["rtf", "docx"],
			["docx", "odt"]
		])
		expect(conversionSteps("docx", "docx")).toEqual([])
	})
})

describe("text conversions in the docx worker", () => {
	it("converts an OpenDocument text document to .docx and leaves the caller's buffer alone", async () => {
		const harness = workerHarness()

		try {
			const source = odtBytes({ body: "<text:p>Hello from ODT</text:p>" })
			const copy = source.slice()
			const result = await harness.pool.convert.convert(source, "odt", "docx")

			if (result.kind !== "converted") throw new Error(result.kind)

			expect(part(result.bytes, "word/document.xml")).toContain("Hello from ODT")
			expect(part(result.bytes, "word/document.xml")).not.toMatch(/w:rsid/)
			expect(source).toEqual(copy)
		} finally {
			harness.dispose()
		}
	})

	it("converts a Word document to .odt", async () => {
		const harness = workerHarness()

		try {
			const result = await harness.pool.convert.convert(await blankDocx({ locale: "en-US" }), "docx", "odt")

			if (result.kind !== "converted") throw new Error(result.kind)

			expect(strFromU8(unzipSync(result.bytes)["mimetype"] ?? new Uint8Array())).toBe("application/vnd.oasis.opendocument.text")
		} finally {
			harness.dispose()
		}
	})

	it("converts RTF to .odt through .docx", async () => {
		const harness = workerHarness()

		try {
			const result = await harness.pool.convert.convert(RTF, "rtf", "odt")

			if (result.kind !== "converted") throw new Error(result.kind)

			expect(part(result.bytes, "content.xml")).toContain("Hello from RTF.")
		} finally {
			harness.dispose()
		}
	})

	it("refuses a file that is not of its format, with the converter's reason", async () => {
		const harness = workerHarness()

		try {
			const result = await harness.pool.convert.convert(latin1("not a zip"), "docx", "odt")

			expect(result.kind === "refused" ? result.reason : result.kind).toBe("notSource")
		} finally {
			harness.dispose()
		}
	})

	it("ends the job when the signal aborts, answering aborted, and lets the worker go idle", async () => {
		const harness = workerHarness(0)

		try {
			const controller = new AbortController()
			const running = harness.pool.convert.convert(await blankDocx({ locale: "en-US" }), "docx", "odt", {
				signal: controller.signal
			})

			controller.abort()

			expect(await running).toEqual({ kind: "aborted" })

			// The idle terminate runs in a timer even at 0 ms.
			await new Promise(resolve => setTimeout(resolve, 0))
			// Released: the aborted job no longer holds the worker.
			expect(harness.terminated()).toBe(1)
			expect(await harness.pool.convert.convert(RTF, "rtf", "docx", { signal: controller.signal })).toEqual({ kind: "aborted" })

			// A fresh job starts a new worker and converts.
			const result = await harness.pool.convert.convert(RTF, "rtf", "docx")

			if (result.kind !== "converted") throw new Error(result.kind)

			expect(part(result.bytes, "word/document.xml")).toContain("Hello from RTF.")
		} finally {
			harness.dispose()
		}
	})
})
