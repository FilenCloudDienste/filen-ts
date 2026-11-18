import { type } from "arktype"
import { sniffImage } from "@/features/preview/lib/imageSniff/sniffImage"

// A Jupyter notebook (.ipynb, nbformat 4) read for its viewer in the text-family worker: cells with their sources, and
// code cells' outputs made ready to show. Images become Blobs (outside the JS heap, shared with the page without a
// copy), typed by their bytes, never their declared type. Nothing a notebook names is fetched.
//
// Hostile-input bounds: the text is at most the text cap (the category's); at most MAX_CELLS cells and MAX_OUTPUTS
// outputs a cell (the rest counted); a source or a text output past MAX_TEXT_CHARS is cut (marked), an HTML or SVG
// output past it is not shown; an image past `maxPixels` (what the device can decode beside the held file) is not made
// a Blob. ANSI escapes are removed from streams and tracebacks. A cell or output of an unknown shape is skipped.

export const MAX_CELLS = 10_000
export const MAX_OUTPUTS = 200
export const MAX_TEXT_CHARS = 1_048_576

export type NotebookOutput =
	| { readonly kind: "stream"; readonly text: string; readonly error: boolean; readonly truncated: boolean }
	| { readonly kind: "error"; readonly name: string; readonly value: string; readonly traceback: string; readonly truncated: boolean }
	| { readonly kind: "text"; readonly text: string; readonly truncated: boolean }
	| { readonly kind: "markdown"; readonly text: string; readonly truncated: boolean }
	| { readonly kind: "html"; readonly html: string }
	| { readonly kind: "image"; readonly blob: Blob; readonly width: number; readonly height: number }
	// SVG text, shown as an image (a data: URL, never a blob URL that could be opened as a document).
	| { readonly kind: "svg"; readonly svg: string }
	// Past a bound: an HTML or SVG output past MAX_TEXT_CHARS, an image past the pixel budget.
	| { readonly kind: "tooLarge" }

export type NotebookCell =
	| { readonly kind: "markdown" | "raw"; readonly source: string; readonly truncated: boolean }
	| {
			readonly kind: "code"
			readonly source: string
			readonly truncated: boolean
			readonly executionCount: number | null
			readonly outputs: readonly NotebookOutput[]
			// Outputs past MAX_OUTPUTS, counted.
			readonly outputsOmitted: number
	  }

export type NotebookReading =
	| {
			readonly status: "ok"
			// The kernel's language as written (a name, then a file extension), for the page to resolve; null for none.
			readonly language: string | null
			readonly extension: string | null
			readonly cells: readonly NotebookCell[]
			// Cells of an unknown shape, skipped.
			readonly cellsSkipped: number
	  }
	| { readonly status: "tooLarge" }
	// Not JSON, or not a notebook of a format this reads (nbformat 4).
	| { readonly status: "invalid" }

const text = type("string | string[]")
const notebookShape = type({
	cells: "unknown[]",
	"nbformat?": "number",
	"metadata?": {
		"language_info?": { "name?": "string", "file_extension?": "string" },
		"kernelspec?": { "language?": "string" }
	}
})
const cellShape = type({
	cell_type: "string",
	source: text,
	"execution_count?": "number | null",
	"outputs?": "unknown[]"
})
const outputShape = type({
	output_type: "string",
	"name?": "string",
	"text?": text,
	"data?": "Record<string, unknown>",
	"ename?": "string",
	"evalue?": "string",
	"traceback?": "string[]"
})

// CSI and OSC sequences, and any other lone escape (built from the characters: a regex literal may not hold them).
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[@-_])`, "g")
const RASTER = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

function joined(value: string | readonly string[]): string {
	return typeof value === "string" ? value : value.join("")
}

function capped(value: string): { readonly text: string; readonly truncated: boolean } {
	return value.length > MAX_TEXT_CHARS ? { text: value.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: value, truncated: false }
}

function plain(value: string | readonly string[]): { readonly text: string; readonly truncated: boolean } {
	return capped(joined(value).replace(ANSI, ""))
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | null {
	try {
		const binary = atob(value.replace(/\s+/g, ""))
		const bytes = new Uint8Array(binary.length)

		for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k)

		return bytes
	} catch {
		return null
	}
}

function image(data: Readonly<Record<string, unknown>>, maxPixels: number): NotebookOutput | null {
	for (const mime of RASTER) {
		const value = data[mime]

		if (typeof value !== "string" && !Array.isArray(value)) continue
		if (!text.allows(value)) continue

		const encoded = joined(value)
		// Base64 holds 3 bytes in 4 characters: a value past the cap is past it decoded too.
		const bytes = encoded.length > MAX_TEXT_CHARS * 8 ? null : base64Bytes(encoded)
		const info = bytes === null ? null : sniffImage(bytes.subarray(0, 65_536), bytes.length)

		if (bytes === null || info === null || !RASTER.some(raster => raster === info.mime)) return null
		if (info.width * info.height > maxPixels) return { kind: "tooLarge" }

		return { kind: "image", blob: new Blob([bytes], { type: info.mime }), width: info.width, height: info.height }
	}

	return null
}

// The richest output a viewer shows safely, in Jupyter's own order of preference.
function displayData(data: Readonly<Record<string, unknown>>, maxPixels: number): NotebookOutput | null {
	const raster = image(data, maxPixels)

	if (raster !== null) return raster

	const svg = data["image/svg+xml"]

	if (text.allows(svg)) {
		const value = joined(svg)

		if (value.length > MAX_TEXT_CHARS) return { kind: "tooLarge" }
		if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(value))
			return { kind: "svg", svg: value }
	}

	const html = data["text/html"]

	if (text.allows(html)) {
		const value = joined(html)

		return value.length > MAX_TEXT_CHARS ? { kind: "tooLarge" } : { kind: "html", html: value }
	}

	const markdown = data["text/markdown"]

	if (text.allows(markdown)) return { kind: "markdown", ...capped(joined(markdown)) }

	const plainText = data["text/plain"]

	return text.allows(plainText) ? { kind: "text", ...plain(plainText) } : null
}

function output(value: unknown, maxPixels: number): NotebookOutput | null {
	const shape = outputShape(value)

	if (shape instanceof type.errors) return null

	switch (shape.output_type) {
		case "stream":
			return { kind: "stream", error: shape.name === "stderr", ...plain(shape.text ?? "") }
		case "error": {
			const traceback = plain((shape.traceback ?? []).join("\n"))

			return {
				kind: "error",
				name: (shape.ename ?? "").replace(ANSI, "").slice(0, 1024),
				value: (shape.evalue ?? "").replace(ANSI, "").slice(0, 4096),
				traceback: traceback.text,
				truncated: traceback.truncated
			}
		}
		case "execute_result":
		case "display_data":
			return shape.data === undefined ? null : displayData(shape.data, maxPixels)
		default:
			return null
	}
}

export function readNotebook(json: string, maxPixels: number): NotebookReading {
	let parsed: unknown

	try {
		parsed = JSON.parse(json)
	} catch {
		return { status: "invalid" }
	}

	const notebook = notebookShape(parsed)

	if (notebook instanceof type.errors || (notebook.nbformat !== undefined && notebook.nbformat < 4)) {
		return { status: "invalid" }
	}

	if (notebook.cells.length > MAX_CELLS) {
		return { status: "tooLarge" }
	}

	const cells: NotebookCell[] = []
	let cellsSkipped = 0

	for (const value of notebook.cells) {
		const cell = cellShape(value)

		if (cell instanceof type.errors) {
			cellsSkipped++
			continue
		}

		const source = capped(joined(cell.source))

		if (cell.cell_type === "markdown" || cell.cell_type === "raw") {
			cells.push({ kind: cell.cell_type, source: source.text, truncated: source.truncated })
			continue
		}

		if (cell.cell_type !== "code") {
			cellsSkipped++
			continue
		}

		const all = cell.outputs ?? []
		const outputs: NotebookOutput[] = []

		for (const entry of all.slice(0, MAX_OUTPUTS)) {
			const shown = output(entry, maxPixels)

			if (shown !== null) outputs.push(shown)
		}

		cells.push({
			kind: "code",
			source: source.text,
			truncated: source.truncated,
			executionCount: cell.execution_count ?? null,
			outputs,
			outputsOmitted: Math.max(0, all.length - MAX_OUTPUTS)
		})
	}

	const info = notebook.metadata?.language_info

	return {
		status: "ok",
		language: info?.name ?? notebook.metadata?.kernelspec?.language ?? null,
		extension: info?.file_extension ?? null,
		cells,
		cellsSkipped
	}
}
