import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"

// Headless LibreOffice: which installs to test with, and batch conversions with --convert-to. Every
// conversion runs in a profile of its own (never the user's), in a process group of its own that is killed
// whole on a timeout, with file locking off (no lock file is ever left next to an input).

export interface Office {
	readonly path: string
	readonly version: string
	// A short name for paths and reports ("lo-7.5.0.3").
	readonly name: string
}

// FILEN_OFFICE_SOFFICE=<soffice>[,<soffice>]: the installs to test; none when unset or none runs.
export function offices(env: NodeJS.ProcessEnv = process.env): Office[] {
	const out: Office[] = []

	for (const path of (env["FILEN_OFFICE_SOFFICE"] ?? "").split(",").filter(item => item !== "")) {
		if (!existsSync(path)) continue

		const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 60_000, env: officeEnv() })
		const version = /(\d+(?:\.\d+)+)/.exec(result.stdout ?? "")?.[1]

		if (result.status === 0 && version !== undefined) out.push({ path, version, name: `lo-${version}` })
	}

	return out
}

export function officeEnv(): NodeJS.ProcessEnv {
	return { ...process.env, SAL_ENABLE_FILE_LOCKING: "0", PYTHONDONTWRITEBYTECODE: "1" }
}

export const FORMATS = {
	pdf: "pdf:writer_pdf_Export",
	odt: "odt:writer8",
	fodt: "fodt:OpenDocument Text Flat XML",
	txt: "txt:Text (encoded):UTF8",
	docx: "docx:MS Word 2007 XML"
} as const

export type Format = keyof typeof FORMATS

// Process groups still running, killed if this process exits first (an interrupted run leaves no office behind).
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

export interface BatchResult {
	readonly code: number | null
	readonly timedOut: boolean
	readonly stderr: string
	readonly ms: number
}

// One soffice --convert-to run over `inputs` into `outdir`.
function convertOnce(
	office: Office,
	profile: string,
	format: Format,
	inputs: readonly string[],
	outdir: string,
	timeoutMs: number
): Promise<BatchResult> {
	return convertWith(office, profile, FORMATS[format], inputs, outdir, timeoutMs)
}

// One soffice --convert-to run with a "<extension>:<filter>[:<options>]" target; the process group is killed
// whole on a timeout.
export function convertWith(
	office: Office,
	profile: string,
	target: string,
	inputs: readonly string[],
	outdir: string,
	timeoutMs: number
): Promise<BatchResult> {
	mkdirSync(outdir, { recursive: true })

	return new Promise(resolve => {
		const started = performance.now()
		const child = spawn(
			office.path,
			[
				`-env:UserInstallation=file://${profile}`,
				"--headless",
				"--norestore",
				"--nologo",
				"--nodefault",
				"--nolockcheck",
				"--convert-to",
				target,
				"--outdir",
				outdir,
				...inputs
			],
			{ detached: true, stdio: ["ignore", "ignore", "pipe"], env: officeEnv() }
		)
		let stderr = ""
		let timedOut = false

		if (child.pid !== undefined) running.add(child.pid)
		const killGroup = (): void => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
			} catch {
				// Already gone.
			}
		}
		const timer = setTimeout(() => {
			timedOut = true
			killGroup()
		}, timeoutMs)

		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000)
		})
		child.on("close", code => {
			clearTimeout(timer)

			if (child.pid !== undefined) running.delete(child.pid)
			if (timedOut) removeTemporaries(outdir)
			// Helpers it started go with it.
			killGroup()
			resolve({ code, timedOut, stderr, ms: Math.round(performance.now() - started) })
		})
	})
}

// A batch gets at most this many files' timeouts (a runaway conversion writes gigabytes in that time); what it
// did not convert is converted one by one.
const BATCH_TIMEOUTS = 4

// The temporary files a killed conversion leaves in the output directory (LibreOffice's "lu*.tmp").
function removeTemporaries(outdir: string): void {
	for (const name of readdirSync(outdir)) if (/^lu\w+\.tmp$/.test(name)) rmSync(join(outdir, name), { force: true })
}

export function outputPath(outdir: string, input: string, format: Format): string {
	return join(outdir, `${basename(input, extname(input))}.${format}`)
}

function present(path: string): boolean {
	return existsSync(path) && statSync(path).size > 0
}

export interface Conversion {
	readonly input: string
	readonly format: Format
	readonly ok: boolean
	// Why not: a timeout, LibreOffice's error output, or no output.
	readonly error?: string
}

// Converts `inputs` to `format`: a batch first, then each input the batch did not convert on its own (so one
// file that hangs or fails is told apart from the batch), `timeoutMs` per file.
export async function convert(
	office: Office,
	profile: string,
	format: Format,
	inputs: readonly string[],
	outdir: string,
	timeoutMs: number
): Promise<Conversion[]> {
	// An output newer than its input is kept from an earlier run in the same directory.
	const stale = inputs.filter(input => {
		const output = outputPath(outdir, input, format)

		return !present(output) || statSync(output).mtimeMs < statSync(input).mtimeMs
	})

	// An older output left in place would pass for a conversion that failed this time.
	for (const input of stale) rmSync(outputPath(outdir, input, format), { force: true })

	const batch =
		stale.length === 0
			? { code: 0, timedOut: false, stderr: "", ms: 0 }
			: await convertOnce(office, profile, format, stale, outdir, timeoutMs * Math.min(stale.length, BATCH_TIMEOUTS))
	const out: Conversion[] = []

	// A killed batch may have left an output half written: each of its inputs is converted again on its own.
	if (batch.timedOut) for (const input of stale) rmSync(outputPath(outdir, input, format), { force: true })

	for (const input of inputs) {
		if (present(outputPath(outdir, input, format))) {
			out.push({ input, format, ok: true })
			continue
		}

		const single =
			stale.length === 1 && !batch.timedOut ? batch : await convertOnce(office, profile, format, [input], outdir, timeoutMs)
		if (single.timedOut) rmSync(outputPath(outdir, input, format), { force: true })

		const ok = present(outputPath(outdir, input, format))
		const error = single.timedOut
			? "timed out"
			: single.stderr
					.split("\n")
					.filter(line => /error|could not|fail/i.test(line) && !/Task policy|Fontconfig/.test(line))
					.join(" ")
					.slice(0, 300) || "no output"

		out.push(ok ? { input, format, ok } : { input, format, ok, error })
	}

	return out
}

// A new profile directory under `root` (one per parallel worker), and its removal.
export function profileDir(root: string, worker: number): string {
	const directory = join(root, `lo-profile-${worker}`)

	mkdirSync(directory, { recursive: true })

	return directory
}

export function removeProfile(directory: string): void {
	rmSync(directory, { recursive: true, force: true })
}
