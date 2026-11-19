import { describe, expect, it } from "vitest"
import {
	MAX_CELLS,
	MAX_IMAGE_BASE64_CHARS,
	MAX_OUTPUTS,
	MAX_TEXT_CHARS,
	isSvgDocument,
	readNotebook
} from "@/features/preview/lib/notebookReading"

// A notebook read for its viewer: cells and outputs in the shapes the viewer shows, images as Blobs typed by their bytes
// and within the pixel budget, ANSI removed, and every bound past which the reading cuts, counts or refuses.

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

function notebook(cells: unknown[], metadata: unknown = { language_info: { name: "python", file_extension: ".py" } }): string {
	return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells })
}

function code(outputs: unknown[], source: string | string[] = "print(1)"): unknown {
	return { cell_type: "code", source, execution_count: 3, metadata: {}, outputs }
}

describe("readNotebook", () => {
	it("reads markdown, raw and code cells with their outputs", () => {
		const reading = readNotebook(
			notebook([
				{ cell_type: "markdown", source: ["# Title\n", "text"], metadata: {} },
				{ cell_type: "raw", source: "raw", metadata: {} },
				code([
					{ output_type: "stream", name: "stdout", text: ["\u001b[31mred\u001b[0m out\n"] },
					{ output_type: "stream", name: "stderr", text: "warn" },
					{
						output_type: "execute_result",
						execution_count: 3,
						data: { "text/plain": "3", "text/html": "<b>3</b>" },
						metadata: {}
					},
					{ output_type: "display_data", data: { "image/png": PNG, "text/plain": "<Figure>" }, metadata: {} },
					{
						output_type: "error",
						ename: "ValueError",
						evalue: "bad",
						traceback: ["\u001b[0;31mTraceback\u001b[0m", "ValueError: bad"]
					}
				])
			]),
			1_000_000
		)

		expect(reading.status).toBe("ok")

		if (reading.status !== "ok") return

		expect(reading).toMatchObject({ language: "python", extension: ".py", cellsSkipped: 0 })
		expect(reading.cells[0]).toEqual({ kind: "markdown", source: "# Title\ntext", truncated: false })
		expect(reading.cells[1]).toEqual({ kind: "raw", source: "raw", truncated: false })

		const cell = reading.cells[2]

		expect(cell?.kind === "code" && cell.outputs.map(output => output.kind)).toEqual(["stream", "stream", "html", "image", "error"])
		expect(cell?.kind === "code" && cell.outputs[0]).toEqual({ kind: "stream", text: "red out\n", error: false, truncated: false })
		expect(cell?.kind === "code" && cell.outputs[1]).toMatchObject({ error: true })
		expect(cell?.kind === "code" && cell.outputs[3]).toMatchObject({ kind: "image", width: 1, height: 1 })
		expect(cell?.kind === "code" && cell.outputs[4]).toMatchObject({ traceback: "Traceback\nValueError: bad" })
	})

	it("types an image by its bytes, and refuses one past the pixel budget", () => {
		const declaredWrong = readNotebook(notebook([code([{ output_type: "display_data", data: { "image/jpeg": PNG } }])]), 1_000_000)
		const overBudget = readNotebook(notebook([code([{ output_type: "display_data", data: { "image/png": PNG } }])]), 0)
		const notAnImage = readNotebook(
			notebook([code([{ output_type: "display_data", data: { "image/png": btoa("<svg/>") } }])]),
			1_000_000
		)

		const first = (reading: ReturnType<typeof readNotebook>) =>
			reading.status === "ok" && reading.cells[0]?.kind === "code" ? reading.cells[0].outputs[0] : undefined

		expect(first(declaredWrong)).toMatchObject({ kind: "image" })
		expect(first(declaredWrong)?.kind === "image" && first(declaredWrong)).toMatchObject({ blob: { type: "image/png" } })
		expect(first(overBudget)).toEqual({ kind: "tooLarge" })
		expect(first(notAnImage)).toBeUndefined()
	})

	it("refuses an image past the base64 cap as too large, and falls back past undecodable base64", () => {
		const outputs = [
			{ output_type: "display_data", data: { "image/png": "A".repeat(MAX_IMAGE_BASE64_CHARS + 4), "text/plain": "<Figure>" } },
			{ output_type: "display_data", data: { "image/png": "!not base64!", "text/plain": "<Figure>" } }
		]
		const reading = readNotebook(notebook([code(outputs)]), 1_000_000)

		expect(reading.status === "ok" && reading.cells[0]?.kind === "code" && reading.cells[0].outputs).toEqual([
			{ kind: "tooLarge" },
			{ kind: "text", text: "<Figure>", truncated: false }
		])
	})

	it("keeps an SVG output only when it is one, and HTML or SVG past the cap as too large", () => {
		const reading = readNotebook(
			notebook([
				code([
					{
						output_type: "display_data",
						data: { "image/svg+xml": '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>' }
					},
					{ output_type: "display_data", data: { "image/svg+xml": "<script>1</script>", "text/plain": "x" } },
					{ output_type: "display_data", data: { "text/html": "x".repeat(MAX_TEXT_CHARS + 1) } }
				])
			]),
			1_000_000
		)

		expect(reading.status === "ok" && reading.cells[0]?.kind === "code" && reading.cells[0].outputs.map(output => output.kind)).toEqual(
			["svg", "text", "tooLarge"]
		)
	})

	it("cuts long text, counts outputs past the limit, skips cells of an unknown shape", () => {
		const outputs = Array.from({ length: MAX_OUTPUTS + 5 }, () => ({ output_type: "stream", name: "stdout", text: "x" }))
		const reading = readNotebook(
			notebook([code(outputs, "y".repeat(MAX_TEXT_CHARS + 10)), { cell_type: "heading", source: "h" }, { nonsense: true }]),
			1_000_000
		)

		expect(reading.status).toBe("ok")

		if (reading.status !== "ok") return

		const cell = reading.cells[0]

		expect(cell?.kind === "code" && [cell.source.length, cell.truncated, cell.outputs.length, cell.outputsOmitted]).toEqual([
			MAX_TEXT_CHARS,
			true,
			MAX_OUTPUTS,
			5
		])
		expect(reading.cellsSkipped).toBe(2)
	})

	it("refuses what is not a version 4 notebook, and too many cells", () => {
		expect(readNotebook("{not json", 0)).toEqual({ status: "invalid" })
		expect(readNotebook(JSON.stringify({ nbformat: 3, worksheets: [] }), 0)).toEqual({ status: "invalid" })
		expect(readNotebook(JSON.stringify({ nbformat: 3, cells: [] }), 0)).toEqual({ status: "invalid" })
		expect(readNotebook(notebook(Array.from({ length: MAX_CELLS + 1 }, () => ({ cell_type: "raw", source: "" }))), 0)).toEqual({
			status: "tooLarge"
		})
	})

	it("falls back to the kernel's language", () => {
		expect(readNotebook(notebook([], { kernelspec: { language: "R" } }), 0)).toMatchObject({ language: "R", extension: null })
	})

	it("gives the notebook's images one pixel budget between them", () => {
		const outputs = Array.from({ length: 3 }, () => ({ output_type: "display_data", data: { "image/png": PNG } }))
		const reading = readNotebook(notebook([code(outputs)]), 2)

		expect(reading.status === "ok" && reading.cells[0]?.kind === "code" && reading.cells[0].outputs.map(output => output.kind)).toEqual(
			["image", "image", "tooLarge"]
		)
	})

	it("tells an SVG document by one forward pass, a near miss of many comments included", () => {
		expect(isSvgDocument('<?xml version="1.0"?>\n<!-- a --><!-- b -->\n<!DOCTYPE svg>\n<svg xmlns="x"/>')).toBe(true)
		expect(isSvgDocument("<svg>")).toBe(true)
		expect(isSvgDocument("<script>1</script><svg>")).toBe(false)

		const started = performance.now()

		expect(isSvgDocument(`${"<!---->".repeat(100_000)}x`)).toBe(false)
		expect(performance.now() - started).toBeLessThan(500)
	})
})
