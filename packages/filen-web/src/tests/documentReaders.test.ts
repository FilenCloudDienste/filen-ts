import { describe, expect, it, vi } from "vitest"
import { LINE_INTS } from "@filen/office/core/text"
import type { DocxDocument } from "@filen/office/react/docx"
import type { SheetSessionApi } from "@filen/office/core/sheet"
import { DocumentTextBuilder, unitRange } from "@/lib/documentText"
import { docxDocumentReader, pagerDocumentReader, pdfDocumentReader, textDocumentReader } from "@/features/preview/lib/documentReaders"
import { heldText } from "@/features/preview/hooks/usePreviewTextDocument"
import type { PagerRowView } from "@/features/preview/workers/textPager.worker"
import type { TextBuffer, TextFile } from "@/features/preview/lib/textFile"
import { sheetDocumentReader } from "@/features/spreadsheet/lib/sheetDocumentReader"
import { slidesDocumentReader } from "@/features/presentation/lib/slidesDocumentReader"

// The readers the viewers publish as the open document: each reads its engine's held state for the units asked for,
// labels where each starts, and stops at the characters asked for.

const signal = (): AbortSignal => new AbortController().signal

describe("the document text builder", () => {
	it("clamps a range to the units there are", () => {
		expect(unitRange({ from: 0, to: 99 }, 5)).toEqual({ from: 1, to: 5 })
		expect(unitRange({ from: 4, to: 2 }, 5)).toEqual({ from: 4, to: 4 })
		expect(unitRange({ from: 1, to: 1 }, 0)).toBeNull()
	})

	it("labels each unit where it starts, a blank line between, and cuts at the limit without splitting a pair", () => {
		const builder = new DocumentTextBuilder(11)

		expect(builder.add("page 1", "abc")).toBe(true)
		expect(builder.add("page 2", "defgh😀")).toBe(false)
		expect(builder.result()).toEqual({
			text: "abc\n\ndefgh",
			units: [
				{ label: "page 1", start: 0 },
				{ label: "page 2", start: 5 }
			],
			truncated: true
		})
		expect(builder.add("page 3", "")).toBe(false)
	})
})

describe("the PDF reader", () => {
	it("reads the pages asked for through the viewer's page text, and nothing for a selection", async () => {
		const pageText = vi.fn((page: number) => Promise.resolve(`text ${String(page)}`))
		const reader = pdfDocumentReader(41, pageText)

		expect(await reader.units()).toBe(41)
		expect((await reader.text({ from: 40, to: 99 }, signal(), 1000)).text).toBe("text 40\n\ntext 41")
		expect(pageText.mock.calls).toEqual([[40], [41]])
		expect(await reader.text("selection", signal(), 1000)).toEqual({ text: "", units: [], truncated: false })
	})

	it("stops reading pages once full, and gives up on an aborted read", async () => {
		const pageText = vi.fn(() => Promise.resolve("0123456789"))
		const reader = pdfDocumentReader(10, pageText)

		expect((await reader.text({ from: 1, to: 10 }, signal(), 15)).truncated).toBe(true)
		expect(pageText).toHaveBeenCalledTimes(2)

		const controller = new AbortController()

		controller.abort()
		await expect(reader.text({ from: 1, to: 1 }, controller.signal, 15)).rejects.toThrow()
	})
})

function docxPage(index: number, text: string): DocxDocument["pages"][number] {
	const lineInts = new Int32Array(LINE_INTS)

	lineInts[2] = 0
	lineInts[3] = text.length
	lineInts[5] = 0

	return { index, sourceCount: 1, sourceTexts: [text], lineCount: 1, lineInts } as unknown as DocxDocument["pages"][number]
}

describe("the Word document reader", () => {
	it("reads the laid-out pages, and says it was cut short past them", async () => {
		const document = { pageCount: 3, pages: [docxPage(0, "one"), docxPage(1, "two")] } as unknown as DocxDocument
		const reader = docxDocumentReader(document)

		expect(await reader.units()).toBe(3)
		expect(await reader.text({ from: 2, to: 3 }, signal(), 100)).toEqual({
			text: "two",
			units: [{ label: "page 2", start: 0 }],
			truncated: true
		})
	})
})

describe("the text readers", () => {
	it("reads a held text whole, cut at the limit", async () => {
		const reader = textDocumentReader(() => "hello world")

		expect(await reader.units()).toBe(1)
		expect(await reader.text({ from: 1, to: 1 }, signal(), 5)).toEqual({
			text: "hello",
			units: [{ label: "text", start: 0 }],
			truncated: true
		})
	})

	it("reads the editor's buffer while it edits, without its byte order mark, else the file", () => {
		const file = { text: "on disk" } as TextFile
		const buffer = { text: () => "﻿edited" } as TextBuffer

		expect(heldText(buffer, file)).toBe("edited")
		expect(heldText(null, file)).toBe("on disk")
	})

	it("reads a large file from its start a band of rows at a time, until the limit or the end", async () => {
		const rows: PagerRowView[] = [
			{ start: 3, end: 9, text: "first", continuation: false, breaks: true, line: null },
			{ start: 9, end: 15, text: "second", continuation: false, breaks: false, line: null }
		]
		const after = vi.fn((from: number) => Promise.resolve(from === 3 ? rows : []))
		const reader = pagerDocumentReader(3, after)

		expect(await reader.text({ from: 1, to: 1 }, signal(), 100)).toEqual({
			text: "first\nsecond",
			units: [{ label: "text", start: 0 }],
			truncated: false
		})
		expect(after.mock.calls).toEqual([
			[3, false, 200],
			[15, true, 200]
		])
		expect((await reader.text({ from: 1, to: 1 }, signal(), 4)).truncated).toBe(true)
	})
})

describe("the spreadsheet reader", () => {
	it("reads each worksheet through the text query at the room left, a chart sheet as empty", async () => {
		const query = vi.fn((_name: "text", request: { sheet: number; maxChars: number }) =>
			Promise.resolve({ text: `cells of ${String(request.sheet)}`, truncated: false })
		)
		const reader = sheetDocumentReader({ query } as unknown as Pick<SheetSessionApi, "query">, [
			{ id: 0, name: "Data", kind: "worksheet" },
			{ id: 1, name: "Chart", kind: "chartsheet" },
			{ id: 2, name: "Totals", kind: "worksheet" }
		])

		expect(await reader.units()).toBe(3)
		expect(await reader.text({ from: 1, to: 3 }, signal(), 1000)).toEqual({
			text: "cells of 0\n\n\n\ncells of 2",
			units: [
				{ label: "Data", start: 0 },
				{ label: "Chart", start: 12 },
				{ label: "Totals", start: 14 }
			],
			truncated: false
		})
		expect(query.mock.calls.map(call => call[1])).toEqual([
			{ sheet: 0, maxChars: 1000 },
			{ sheet: 2, maxChars: 986 }
		])
	})

	it("stops at a sheet the worker cut", async () => {
		const query = vi.fn(() => Promise.resolve({ text: "partial", truncated: true }))
		const reader = sheetDocumentReader({ query }, [
			{ id: 0, name: "A", kind: "worksheet" },
			{ id: 1, name: "B", kind: "worksheet" }
		])

		expect(await reader.text({ from: 1, to: 2 }, signal(), 7)).toEqual({
			text: "partial",
			units: [{ label: "A", start: 0 }],
			truncated: true
		})
		expect(query).toHaveBeenCalledTimes(1)
	})
})

describe("the slides reader", () => {
	it("asks the deck's worker for 0-based slides and labels them 1-based, notes after the slide", async () => {
		const text = vi.fn(() =>
			Promise.resolve({
				slides: [
					{ index: 1, text: "Second", notes: "Say hi" },
					{ index: 2, text: "Third", notes: "" }
				],
				truncated: false
			})
		)
		const reader = slidesDocumentReader({ text }, 6)

		expect(await reader.units()).toBe(6)
		expect(await reader.text({ from: 2, to: 3 }, signal(), 500)).toEqual({
			text: "Second\n\nNotes:\nSay hi\n\nThird",
			units: [
				{ label: "slide 2", start: 0 },
				{ label: "slide 3", start: 23 }
			],
			truncated: false
		})
		expect(text).toHaveBeenCalledWith(1, 2, 500)
	})
})
