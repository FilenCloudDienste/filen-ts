import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readdirSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { CORPUS_DIR } from "../corpusDir"

// The fuzzers' configuration (environment variables), seeds, the corpus listing and the pool of child
// processes that run the fuzz jobs (run.ts). Nothing here loads the package, so a skipped fuzz test costs
// nothing.

export type Rand = () => number

// mulberry32
export function rng(seed: number): Rand {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// ---- configuration ----

export interface FuzzConfig {
	// Runs per corpus file: seeds per file and mode (paged fuzz), sequences per file (damage fuzz).
	readonly runs: number
	readonly seed: number
	// Only corpus files whose name contains this.
	readonly filter: string | undefined
	// Ops per run: steps (paged fuzz, default 20), the most per session (damage fuzz, default 16).
	readonly steps: number | undefined
	// Only these ops (names from ops/), picked uniformly.
	readonly ops: readonly string[] | undefined
	// Only these op families (features in ops/index.ts), at their usual shares.
	readonly families: readonly string[] | undefined
	// Paged fuzz: sync, race and/or proof (default sync,race). Damage fuzz: stories, undo, blockmove, undoall, selftest,
	// xsd (default stories).
	readonly modes: readonly string[] | undefined
	readonly view: "final" | "markup" | "original" | undefined
	readonly jobs: number
	// Appends every result and finding as a JSON line.
	readonly out: string | undefined
}

function list(value: string | undefined): readonly string[] | undefined {
	return value === undefined || value === "" ? undefined : value.split(",").map(item => item.trim())
}

function count(value: string | undefined, name: string): number | undefined {
	if (value === undefined || value === "") return undefined

	const parsed = Number(value)

	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a whole number: ${value}`)

	return parsed
}

// FILEN_OFFICE_FUZZ=<runs> turns the fuzzers on; without it they are skipped.
export function fuzzConfig(env: NodeJS.ProcessEnv = process.env): FuzzConfig | undefined {
	const runs = count(env["FILEN_OFFICE_FUZZ"], "FILEN_OFFICE_FUZZ")

	if (runs === undefined || runs === 0) return undefined

	const view = env["FILEN_OFFICE_FUZZ_VIEW"] || undefined

	if (view !== undefined && view !== "final" && view !== "markup" && view !== "original")
		throw new Error("FILEN_OFFICE_FUZZ_VIEW: final, markup or original")

	return {
		runs,
		seed: count(env["FILEN_OFFICE_FUZZ_SEED"], "FILEN_OFFICE_FUZZ_SEED") ?? 1,
		filter: env["FILEN_OFFICE_FUZZ_FILTER"] || undefined,
		steps: count(env["FILEN_OFFICE_FUZZ_STEPS"], "FILEN_OFFICE_FUZZ_STEPS"),
		ops: list(env["FILEN_OFFICE_FUZZ_OPS"]),
		families: list(env["FILEN_OFFICE_FUZZ_FAMILIES"]),
		modes: list(env["FILEN_OFFICE_FUZZ_MODES"]),
		view,
		jobs: count(env["FILEN_OFFICE_FUZZ_JOBS"], "FILEN_OFFICE_FUZZ_JOBS") || Math.max(1, availableParallelism() - 1),
		out: env["FILEN_OFFICE_FUZZ_OUT"] || undefined
	}
}

export const CORPUS = CORPUS_DIR

// The editable word-processing extensions.
export const WORD_EXTENSIONS: readonly string[] = ["docx", "docm", "dotx", "dotm"]

// Corpus files of these extensions (each in its own directory), sorted, matching `filter`.
export function corpusFiles(extensions: readonly string[], filter?: string): string[] {
	const files: string[] = []

	for (const extension of extensions) {
		const directory = join(CORPUS, extension)

		if (!existsSync(directory)) continue

		for (const name of readdirSync(directory).sort())
			if (name.endsWith(`.${extension}`) && (filter === undefined || name.includes(filter))) files.push(join(directory, name))
	}

	return files
}

// FNV-1a: a file's own seed space, so a sequence replays from the file name and seed alone.
export function nameHash(name: string): number {
	let hash = 0x811c9dc5

	for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193)

	return hash >>> 0
}

// ---- outcomes ----

// Why a corpus file may not be fuzzed: encrypted packages, and documents that open view-only (Gate 0). Any
// other refusal (an exception, a package that no longer opens) is lost coverage and fails the run.
const VIEW_ONLY = new Set(["strict", "signed", "protected", "writeProtected", "malformed"])

export function expectedRefusal(reason: string): boolean {
	if (reason === "unopenable (encrypted)") return true

	const reasons = /^view-only \((.+)\)$/.exec(reason)?.[1]

	return reasons !== undefined && reasons.split(", ").every(item => VIEW_ONLY.has(item))
}

// Protection modes that may leave a document nothing an op can change (forms with no field, comments only):
// a run there may apply no edit. A document protected for tracked changes can always be edited.
export function limitedProtection(mode: unknown): boolean {
	return mode === "forms" || mode === "comments"
}

// Whether a run over a document must apply some edit (the fuzz tests fail one that applies none): not under a
// protection that may leave nothing to change, nor with the ops narrowed to some the document may have no use for.
// Where few ops apply (read-only protection with small open ranges, a document of a block or two), a run that has
// applied none keeps drawing past its length, up to a limit, so it fails only when nothing applies.
export function editExpected(config: FuzzConfig, protection: unknown): boolean {
	return config.ops === undefined && config.families === undefined && !limitedProtection(protection)
}

// Prints a run's summary, and adds it to the GitHub Actions job summary when there is one.
export function summarize(line: string): void {
	console.log(line)

	const summary = process.env["GITHUB_STEP_SUMMARY"]

	if (summary) appendFileSync(summary, `${line}\n\n`)
}

// ---- child processes ----

export interface JobResult {
	readonly args: readonly string[]
	// JSON lines the job printed.
	readonly lines: readonly string[]
	readonly code: number | null
	readonly timedOut: boolean
	readonly stderr: string
}

const RUNNER = join(import.meta.dirname, "run.ts")
// Jobs still running, killed if this process exits first (an interrupted run leaves none behind).
const running = new Set<ReturnType<typeof spawn>>()

process.once("exit", () => {
	for (const child of running) child.kill("SIGKILL")
})
const PACKAGE = join(import.meta.dirname, "..", "..", "..")

// Runs each job (arguments to run.ts) in its own Node process, `parallel` at a time: a job that crashes or
// hangs costs only itself.
export async function runJobs(
	jobs: readonly (readonly string[])[],
	parallel: number,
	timeoutMs: number,
	onResult: (result: JobResult) => void
): Promise<void> {
	let next = 0

	const worker = async (): Promise<void> => {
		while (next < jobs.length) {
			const args = jobs[next++] as readonly string[]

			onResult(await runJob(args, timeoutMs))
		}
	}

	await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker))
}

function runJob(args: readonly string[], timeoutMs: number): Promise<JobResult> {
	return new Promise(resolve => {
		const child = spawn(process.execPath, ["--import", "tsx", RUNNER, ...args], {
			cwd: PACKAGE,
			stdio: ["ignore", "pipe", "pipe"]
		})
		const lines: string[] = []
		let pending = ""

		running.add(child)
		let stderr = ""
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeoutMs)

		child.stdout.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			pending += chunk

			const parts = pending.split("\n")

			pending = parts.pop() ?? ""

			for (const line of parts) if (line.startsWith("{")) lines.push(line)
		})
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk: string) => {
			// The tail is what explains a crash.
			stderr = (stderr + chunk).slice(-4000)
		})
		child.on("close", code => {
			clearTimeout(timer)
			running.delete(child)

			if (pending.startsWith("{")) lines.push(pending)

			resolve({ args, lines, code, timedOut, stderr })
		})
	})
}
