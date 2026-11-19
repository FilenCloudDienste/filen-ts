import { MessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import type { PdfFontAssets } from "@filen/office/core/pdfwrite/fonts"
import { checkSheetPassword, serveSheetWorker, sheetWorkerHost, type SheetWorkerLike } from "@filen/office/dom/sheet"
import { SHEET_PDF_JOB, sheetPdf, type SheetPdfRequest } from "@filen/office/react/sheet/print"
import { sheetWorkbookJobs } from "@/features/spreadsheet/workers/sheetWorkbookJobs"
import { sheetWorkbookOpener } from "@/features/spreadsheet/workers/sheetWorkbookOpener"
import { encryptedWorkbook, plainWorkbook, WORKBOOK_PASSWORD } from "@/tests/encryptedWorkbookFixtures"

// The workbook worker's own job table: a protected workbook's PDF export asks it to check the password first.

const NO_FONTS: PdfFontAssets = {
	open: () => Promise.reject(new Error("no fonts in this test"))
}

const closers: (() => void)[] = []

afterEach(() => {
	for (const close of closers.splice(0)) close()
})

interface Posted {
	readonly message: unknown
	readonly transfer: readonly ArrayBuffer[]
}

// `posted`: what the page sends, with its transfer list.
function workbookWorker(posted: Posted[] = []) {
	const { port1, port2 } = new MessageChannel()
	const page: SheetWorkerLike = {
		postMessage: (message, transfer) => {
			posted.push({ message, transfer: transfer ?? [] })
			port1.postMessage(message, transfer ?? [])
		},
		addEventListener: (type, listener) => {
			if (type === "message") {
				port1.on("message", (data: unknown) => {
					listener({ data })
				})
			}
		}
	}

	serveSheetWorker(
		{
			post: (message, transfer) => {
				port2.postMessage(message, [...transfer])
			},
			listen: onMessage => {
				port2.on("message", onMessage)
			}
		},
		sheetWorkbookOpener(),
		sheetWorkbookJobs(NO_FONTS)
	)

	const host = sheetWorkerHost(page)

	closers.push(() => {
		host.dispose()
		port1.close()
		port2.close()
	})

	return host
}

// The session only routes the job to its worker; the check opens the stored file it is given.
async function openedSession(posted?: Posted[]) {
	const opened = await workbookWorker(posted).open(plainWorkbook(), { kind: "xlsx" }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	return opened.session
}

describe("the workbook worker's password check", () => {
	it("knows a default-password workbook needs no password", async () => {
		const stored = await encryptedWorkbook("default")

		expect(await checkSheetPassword(await openedSession(), stored, "")).toBe("default")
	}, 30_000)

	it("tells a wrong password from the right one", async () => {
		const stored = await encryptedWorkbook("agile")
		const session = await openedSession()

		expect(await checkSheetPassword(session, stored, "nope")).toBe("wrong")
		expect(await checkSheetPassword(session, stored, WORKBOOK_PASSWORD)).toBe("accepted")
	}, 30_000)

	it("hands its own copy of the file to the worker and keeps the caller's", async () => {
		const stored = await encryptedWorkbook("default")
		const before = stored.slice()
		const posted: Posted[] = []
		const session = await openedSession(posted)

		posted.length = 0

		expect(await checkSheetPassword(session, stored, "")).toBe("default")

		const job = posted.find(post => (post.message as { t?: string }).t === "job")
		const sent = (job?.message as { args: { bytes: Uint8Array } } | undefined)?.args.bytes

		expect(job?.message).not.toHaveProperty("transfer")
		expect(job?.transfer).toHaveLength(1)
		expect(job?.transfer[0]).toBe(sent?.buffer)
		expect(job?.transfer[0]).not.toBe(stored.buffer)
		expect(stored).toEqual(before)
	}, 30_000)

	it("transfers nothing of a print's request", async () => {
		const posted: Posted[] = []
		const session = await openedSession(posted)
		const request: SheetPdfRequest = {
			sheets: [],
			values: { date: "", time: "", file: "", path: "" },
			title: "",
			kind: "xlsx",
			summaries: [],
			date1904: false,
			showFormulas: false
		}

		posted.length = 0

		await sheetPdf(session, request).catch(() => undefined)

		const job = posted.find(post => (post.message as { t?: string }).t === "job")

		expect((job?.message as { name?: string } | undefined)?.name).toBe(SHEET_PDF_JOB)
		expect(job?.transfer).toEqual([])
	}, 30_000)
})
