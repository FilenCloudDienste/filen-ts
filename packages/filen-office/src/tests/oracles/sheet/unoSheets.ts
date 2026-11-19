import { spawn, type ChildProcessByStdio } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { extname, join } from "node:path"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { officeEnv } from "../../interop/soffice"
import { sheetProfile, unoEnv, type SheetOffice } from "./libreOffice"

// The LibreOffice UNO runner (uno/sheet.py) as a long-lived pair: a headless soffice on a pipe, and the bundled
// Python, isolated (-I), talking to it. Each job loads a copy of a workbook, hard-recalculates it, dumps every
// non-empty cell (value and shown text), replays structure operations and stores the result as xlsx.

const SCRIPT = join(import.meta.dirname, "uno", "sheet.py")

export type UnoValue = number | string | boolean

// [row, column, type, value, shown, formula?]: 0-based; type "n", "s", "b" or "e" (value: LibreOffice's error text).
export type UnoCell = readonly [number, number, "n" | "s" | "b" | "e", UnoValue, string, string?]

export interface UnoSheet {
	readonly name: string
	readonly visible: boolean
	readonly cells: readonly UnoCell[]
}

export interface UnoWorkbook {
	readonly sheets: readonly UnoSheet[]
	readonly names: readonly { readonly name: string; readonly content: string }[]
}

export type UnoOperation =
	| {
			readonly op: "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns"
			readonly sheet: string | number
			readonly at: number
			readonly count: number
	  }
	| {
			readonly op: "sort"
			readonly sheet: string | number
			readonly range: string
			readonly keys: readonly { readonly column: number; readonly ascending?: boolean; readonly caseSensitive?: boolean }[]
			readonly header?: boolean
	  }
	| { readonly op: "deleteSheet"; readonly sheet: string | number }
	| { readonly op: "moveSheet"; readonly sheet: string | number; readonly to: number }
	| { readonly op: "mergeCells" | "unmergeCells"; readonly sheet: string | number; readonly range: string }
	| {
			readonly op: "hideRows" | "hideColumns"
			readonly sheet: string | number
			readonly at: number
			readonly count: number
			readonly hidden?: boolean
	  }
	| { readonly op: "freeze"; readonly sheet: string | number; readonly rows: number; readonly cols: number }
	| { readonly op: "copySheet"; readonly sheet: string | number; readonly name: string; readonly to: number }
	| { readonly op: "renameSheet"; readonly sheet: string | number; readonly name: string }
	| { readonly op: "hideSheet"; readonly sheet: string | number; readonly hidden?: boolean }
	| { readonly op: "tabColor"; readonly sheet: string | number; readonly color: number }
	| { readonly op: "protectSheet"; readonly sheet: string | number; readonly password?: string }
	// Cells of `range` inserted (the cells there shifted down or right) or removed (the cells after shifted up or left).
	| { readonly op: "insertCells"; readonly sheet: string | number; readonly range: string; readonly mode: "down" | "right" }
	| { readonly op: "removeCells"; readonly sheet: string | number; readonly range: string; readonly mode: "up" | "left" }

export interface UnoJob {
	readonly input: string
	readonly ops?: readonly UnoOperation[]
	// Where LibreOffice stores the (operated) workbook as xlsx.
	readonly saveAs?: string
	// Cells dumped at most (both dumps together); the rest is left out and `truncated` set.
	readonly maxCells?: number
	readonly password?: string
	// Each sheet's view as LibreOffice loads it (UnoView).
	readonly views?: boolean
}

// A sheet's view as LibreOffice loads it: frozen or not, the split's row and column, and each pane's first visible
// row and column (0-based, in LibreOffice's pane order).
export interface UnoView {
	readonly name: string
	readonly frozen: boolean
	readonly splitRow: number
	readonly splitColumn: number
	readonly panes: readonly (readonly [number, number])[]
}

export interface UnoResult {
	readonly ok: boolean
	readonly error?: string
	readonly ms: number
	// Whether calculateAll ran: a workbook calling WEBSERVICE, STOCKHISTORY, RTD or DDE is not recalculated.
	readonly calculated?: boolean
	readonly skipCalc?: string
	readonly cells?: number
	readonly truncated?: boolean
	readonly ops?: readonly { readonly ok: boolean; readonly error?: string }[]
	readonly saved?: string
	readonly views?: readonly UnoView[]
	readonly before?: UnoWorkbook
	readonly after?: UnoWorkbook
}

interface RawResult extends Omit<UnoResult, "before" | "after"> {
	readonly id: number
}

const STARTUP_TIMEOUT_MS = 120_000
// How long close() waits for the runner to exit on EOF (closing its document) before killing it.
const CLOSE_GRACE_MS = 5000

// Office process groups still running, killed if this process exits first.
const running = new Set<number>()

process.once("exit", () => {
	for (const pid of running) {
		try {
			process.kill(-pid, "SIGKILL")
		} catch {
			// Already gone.
		}
	}
})

export class UnoSheets {
	readonly office: SheetOffice
	private readonly work: string
	private readonly soffice: ChildProcessByStdio<null, null, null>
	private readonly python: ChildProcessByStdio<Writable, Readable, null>
	private readonly lines: AsyncIterator<string>
	private next = 0
	private readonly ready: Promise<void>

	// `office` must have a working bundled Python (SheetOffice.unoMissing undefined).
	constructor(office: SheetOffice, scratch: string) {
		if (office.resources === undefined || office.unoMissing !== undefined)
			throw new Error(`${office.name} cannot run UNO: ${office.unoMissing ?? "no Resources directory"}`)

		this.office = office
		this.work = mkdtempSync(join(scratch, "uno-"))

		const profile = sheetProfile(this.work, office.name)
		const pipe = `filen-office-sheet-${process.pid}-${Date.now()}`

		this.soffice = spawn(
			office.path,
			[
				`-env:UserInstallation=file://${profile}`,
				"--headless",
				"--norestore",
				"--nologo",
				"--nodefault",
				"--nolockcheck",
				`--accept=pipe,name=${pipe};urp;`
			],
			{ detached: true, stdio: ["ignore", "ignore", "ignore"], env: officeEnv() }
		)

		if (this.soffice.pid !== undefined) running.add(this.soffice.pid)

		this.python = spawn(join(office.resources, "python"), ["-I", SCRIPT, office.resources, pipe], {
			stdio: ["pipe", "pipe", "inherit"],
			env: unoEnv(office.resources)
		})
		this.lines = createInterface({ input: this.python.stdout })[Symbol.asyncIterator]()
		// A write to a runner that already exited fails with EPIPE; readLine() reports the exit from stdout.
		this.python.stdin.on("error", () => undefined)
		this.ready = this.readLine(STARTUP_TIMEOUT_MS).then(line => {
			if (!(JSON.parse(line) as { ready?: boolean }).ready) throw new Error(`UNO runner did not start: ${line}`)
		})
	}

	private async readLine(timeoutMs: number): Promise<string> {
		let timer: NodeJS.Timeout | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`UNO runner silent for ${timeoutMs} ms`)), timeoutMs)
		})

		try {
			const line = await Promise.race([this.lines.next(), timeout])

			if (line.done === true) throw new Error("The UNO runner exited")

			return line.value
		} finally {
			clearTimeout(timer)
		}
	}

	// Runs one job on a copy of its input (the original is never handed to LibreOffice).
	async run(job: UnoJob, timeoutMs = 600_000): Promise<UnoResult> {
		await this.ready

		const id = this.next++
		const directory = join(this.work, String(id))

		mkdirSync(directory)

		try {
			const input = join(directory, `input${extname(job.input).toLowerCase()}`)
			const out = join(directory, "dump.json")

			copyFileSync(job.input, input)
			this.python.stdin.write(`${JSON.stringify({ ...job, id, input, out })}\n`)

			const { id: answered, ...result } = JSON.parse(await this.readLine(timeoutMs)) as RawResult

			if (answered !== id) throw new Error(`UNO runner answered job ${answered}, not ${id}`)

			if (!result.ok) return result

			const dump = JSON.parse(readFileSync(out, "utf8")) as { before: UnoWorkbook; after?: UnoWorkbook }

			return { ...result, before: dump.before, ...(dump.after !== undefined && { after: dump.after }) }
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	}

	// Ends the runner's input so it closes its document and exits (killed after `graceMs`, as when a job hangs
	// LibreOffice), then kills soffice's process group and removes the work directory.
	async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
		const python = this.python

		// Startup may still be pending, or have failed, when no job ever ran.
		void this.ready.catch(() => undefined)

		try {
			if (python.exitCode === null && python.signalCode === null) {
				const exited = new Promise<void>(resolve => python.once("exit", () => resolve()))
				const timer = setTimeout(() => python.kill("SIGKILL"), graceMs)

				python.stdin.end()

				try {
					await exited
				} finally {
					clearTimeout(timer)
				}
			}
		} finally {
			try {
				if (this.soffice.pid !== undefined) process.kill(-this.soffice.pid, "SIGKILL")
			} catch {
				// Already gone.
			}

			if (this.soffice.pid !== undefined) running.delete(this.soffice.pid)

			rmSync(this.work, { recursive: true, force: true })
		}
	}
}

export function unoSheetByName(workbook: UnoWorkbook, name: string): UnoSheet | undefined {
	return workbook.sheets.find(sheet => sheet.name === name)
}
