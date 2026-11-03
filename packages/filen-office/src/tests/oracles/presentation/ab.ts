import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { bytesSource } from "../../../core/opc/index"
import { openOdtAsDocx } from "../../../core/odt/index"
import type { SheetFileKind, SheetSessionApi, SheetWorkbookInfo } from "../../../core/sheet/protocol"
import { docxWorkerPool, serveDocxWorker, type DocxEngineServices, type DocxWorkerPool } from "../../../dom/docx/index"
import { exportDocxPdf } from "../../../dom/docx/pdf"
import { inThreadSheetHost } from "../../../dom/sheet/host"
import { exportSheetPdf, type SheetPdfRequest } from "../../../react/sheet/print/pdfExport"
import type { PrintSheetRequest } from "../../../react/sheet/print/printLayout"
import { pdfAssets } from "../../docxPdfFixtures"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "../../layoutFixtures"
import { pdfBytes } from "../../sheetPdfFixtures"

// The A/B gate for the engines presentations share with the other editors: every docx, odt, rtf, doc, xlsx and ods
// corpus file exported to PDF in deterministic mode, so a change to a shared engine shows as a PDF that is no longer
// byte-identical to the baseline. Documents are laid out with the bundled fonts' real advance widths; workbooks print
// every visible worksheet as "Entire workbook" does. A driver runs it once per batch:
//   node --import tsx src/tests/oracles/presentation/ab.ts run --files <list> --corpus <dir> --out <dir>
// prints one JSON line per file (a "start" line first, so a driver can stop a file that hangs).

export const AB_FORMATS = ["docx", "odt", "rtf", "doc", "xlsx", "ods"] as const

export type AbFormat = (typeof AB_FORMATS)[number]

export type AbExport =
	| { readonly outcome: "pdf"; readonly pdf: Uint8Array; readonly pages: number }
	| { readonly outcome: "refused" | "failed"; readonly reason: string }

export interface AbResult {
	readonly path: string
	readonly sha256: string
	readonly outcome: "pdf" | "refused" | "failed" | "timeout"
	readonly pdfSha256?: string
	readonly size?: number
	readonly pages?: number
	readonly reason?: string
}

export interface AbDifference {
	readonly path: string
	readonly baseline: AbResult | undefined
	readonly current: AbResult | undefined
}

export function isAbFormat(format: string): format is AbFormat {
	return (AB_FORMATS as readonly string[]).includes(format)
}

function documentServices(): DocxEngineServices {
	return {
		fontHost: nodeFontHost,
		replayFonts: false,
		fontAssets: nodeFontAssets,
		measurer: new HmtxMeasurer(),
		yield: () => new Promise(done => setImmediate(done)),
		// One slice per document: what is laid out never depends on where the slices fell.
		sliceMs: Number.MAX_SAFE_INTEGER,
		now: () => 0,
		openOdt: openOdtAsDocx
	}
}

// The docx worker on a MessagePort pair, as the web runs it: the conversions of doc and rtf to the package the
// document engine opens.
function conversionPool(): { readonly pool: DocxWorkerPool; dispose(): void } {
	const ports: MessagePort[] = []
	const pool = docxWorkerPool(() => {
		const { port1: page, port2: worker } = new MessageChannel()

		ports.push(page, worker)
		serveDocxWorker(
			{
				post: (message, transfer) => worker.postMessage(message, [...transfer]),
				listen: onMessage => worker.on("message", onMessage)
			},
			documentServices
		)

		return {
			post: (message, transfer) => page.postMessage(message, [...transfer]),
			listen: onMessage => page.on("message", onMessage),
			terminate() {
				page.close()
				worker.close()
			}
		}
	}, 0)

	return {
		pool,
		dispose() {
			pool.dispose()

			for (const port of ports) port.close()
		}
	}
}

let shared: ReturnType<typeof conversionPool> | undefined

function pool(): DocxWorkerPool {
	shared ??= conversionPool()

	return shared.pool
}

export function disposeAb(): void {
	shared?.dispose()
	shared = undefined
}

function failure(error: unknown): AbExport {
	const reason = error instanceof Error ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}` : String(error)
	const refused =
		typeof error === "object" && error !== null && "reason" in error ? String((error as { reason: unknown }).reason) : undefined

	return refused === undefined || refused === "failed" ? { outcome: "failed", reason } : { outcome: "refused", reason: refused }
}

async function documentPdf(bytes: Uint8Array, title: string, format: "docx" | "odt", untranslated = 0): Promise<AbExport> {
	const result = await exportDocxPdf(bytes, documentServices(), pdfAssets, {
		options: { title, deterministic: true, format, ...(untranslated > 0 ? { untranslated } : {}) },
		signal: { aborted: false }
	})
	const pdf = new Uint8Array(await result.blob.arrayBuffer())

	return { outcome: "pdf", pdf, pages: await pageCount(pdf) }
}

async function pageCount(pdf: Uint8Array): Promise<number> {
	const task = pdfjs.getDocument({ data: pdf.slice(), verbosity: 0 })

	try {
		return (await task.promise).numPages
	} finally {
		await task.destroy()
	}
}

async function legacyDocPdf(bytes: Uint8Array, title: string): Promise<AbExport> {
	const opened = await pool().legacy.open(bytesSource(bytes))

	if (opened.kind === "refused") return { outcome: "refused", reason: opened.refusal.reason }
	if (opened.kind !== "converted") return { outcome: "failed", reason: opened.kind }

	try {
		return await documentPdf(await opened.document.take(), title, "docx")
	} finally {
		opened.document.release()
	}
}

async function rtfPdf(bytes: Uint8Array, title: string): Promise<AbExport> {
	const opened = await pool().rtf.open(bytes)

	if (opened.kind !== "opened") return { outcome: opened.kind === "notRtf" ? "refused" : "failed", reason: opened.kind }

	try {
		return await documentPdf(await opened.document.take(), title, "docx", opened.document.untranslated)
	} finally {
		opened.document.release()
	}
}

// Every visible worksheet with its own print settings, as "Entire workbook" prints it.
async function workbookRequest(session: SheetSessionApi, info: SheetWorkbookInfo, title: string): Promise<SheetPdfRequest> {
	const sheets: PrintSheetRequest[] = []

	for (const sheet of info.sheets) {
		if (sheet.state !== "visible" || sheet.kind !== "worksheet") continue

		const settings = await session.query("print.settings", { sheet: sheet.id })

		if (settings === null) continue

		sheets.push({
			sheet: sheet.id,
			name: sheet.name,
			setup: settings.setup,
			used: settings.used,
			ranges: settings.setup.printArea ?? (settings.used === null ? [] : [settings.used])
		})
	}

	for (const request of sheets) await session.layout(request.sheet)

	return {
		sheets,
		values: { date: "1/2/2026", time: "10:00", file: title, path: "" },
		title,
		lang: "en",
		kind: info.kind,
		summaries: info.sheets,
		date1904: info.date1904,
		showFormulas: false
	}
}

const IMMEDIATE = { sliceMs: Number.MAX_SAFE_INTEGER, now: () => 0, pause: () => Promise.resolve() }

async function workbookPdf(bytes: Uint8Array, title: string, kind: SheetFileKind): Promise<AbExport> {
	const host = inThreadSheetHost()
	const opened = await host.open(bytes.slice(), { kind, slicing: IMMEDIATE }, () => undefined)

	if (opened.kind !== "opened")
		return {
			outcome: opened.kind === "failed" ? "failed" : "refused",
			reason: "reason" in opened ? String(opened.reason) : opened.kind
		}

	try {
		const request = await workbookRequest(opened.session, opened.info, title)

		// Recalculation and layout settle in macrotask turns of their own.
		for (let k = 0; k < 30; k++) await new Promise(done => setImmediate(done))

		const result = await exportSheetPdf(request, {
			session: opened.session,
			assets: pdfAssets,
			deterministic: true,
			slicing: IMMEDIATE
		})

		if (!result.ok) return { outcome: "refused", reason: result.reason }

		return { outcome: "pdf", pdf: pdfBytes(result.output.parts), pages: result.pages }
	} finally {
		opened.session.close()
	}
}

// The PDF a corpus file exports to, titled from its file name as the apps title an untitled document.
export async function exportForAb(format: AbFormat, bytes: Uint8Array, title: string): Promise<AbExport> {
	try {
		switch (format) {
			case "docx":
				return await documentPdf(bytes, title, "docx")
			case "odt":
				return await documentPdf(bytes, title, "odt")
			case "doc":
				return await legacyDocPdf(bytes, title)
			case "rtf":
				return await rtfPdf(bytes, title)
			case "xlsx":
				return await workbookPdf(bytes, title, "xlsx")
			case "ods":
				return await workbookPdf(bytes, title, "ods")
		}
	} catch (error) {
		return failure(error)
	}
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

// What differs between two runs: outcome, PDF bytes, or a file only one of them has. Failure messages are compared
// too (a refusal that changes its reason is a change).
export function compareAb(baseline: readonly AbResult[], current: readonly AbResult[]): AbDifference[] {
	const before = new Map(baseline.map(result => [result.path, result]))
	const after = new Map(current.map(result => [result.path, result]))
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort()

	return paths.flatMap(path => {
		const a = before.get(path)
		const b = after.get(path)
		const same =
			a !== undefined &&
			b !== undefined &&
			a.sha256 === b.sha256 &&
			a.outcome === b.outcome &&
			a.pdfSha256 === b.pdfSha256 &&
			(a.outcome === "pdf" || a.reason === b.reason)

		return same ? [] : [{ path, baseline: a, current: b }]
	})
}

async function run(args: readonly string[]): Promise<void> {
	const at = (name: string): string => {
		const index = args.indexOf(`--${name}`)
		const value = index >= 0 ? args[index + 1] : undefined

		if (value === undefined) throw new Error(`--${name} is required`)

		return value
	}
	const corpus = resolve(at("corpus"))
	const out = resolve(at("out"))
	const files = readFileSync(at("files"), "utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "")

	for (const path of files) {
		process.stdout.write(`${JSON.stringify({ start: path })}\n`)

		const format = extname(path).slice(1).toLowerCase()
		const bytes = new Uint8Array(readFileSync(join(corpus, path)))
		const base = { path, sha256: sha256(bytes) }
		const exported = isAbFormat(format) ? await exportForAb(format, bytes, basename(path, extname(path))) : undefined
		let result: AbResult

		if (exported === undefined) result = { ...base, outcome: "failed", reason: `not an A/B format: ${format}` }
		else if (exported.outcome === "pdf") {
			const target = join(out, "pdf", `${path}.pdf`)

			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, exported.pdf)
			result = { ...base, outcome: "pdf", pdfSha256: sha256(exported.pdf), size: exported.pdf.length, pages: exported.pages }
		} else result = { ...base, outcome: exported.outcome, reason: exported.reason }

		process.stdout.write(`${JSON.stringify({ result })}\n`)
	}

	disposeAb()
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename && process.argv[2] === "run")
	await run(process.argv.slice(3))
