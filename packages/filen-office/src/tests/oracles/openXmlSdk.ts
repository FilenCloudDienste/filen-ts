import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"

// The Open XML SDK validator (tools/openxml-validate, FileFormatVersions.Microsoft365) as a long-lived child:
// one path in, one JSON line out. FILEN_OFFICE_OOXML_VALIDATOR names the built OpenXmlValidate.dll;
// FILEN_OFFICE_DOTNET the dotnet host (else "dotnet" on PATH).

export const VALIDATOR = process.env["FILEN_OFFICE_OOXML_VALIDATOR"] ?? ""
const DOTNET = process.env["FILEN_OFFICE_DOTNET"] || "dotnet"
const ALLOW = fileURLToPath(new URL("../../../tools/openxml-validate/allow.json", import.meta.url))

// The extensions the validator opens as each package kind (tools/openxml-validate/Program.cs); it opens any other
// path as a word-processing document, so a caller validates only these and decrypts encrypted packages first.
export const SDK_EXTENSIONS = {
	wordprocessing: ["docx", "docm", "dotx", "dotm"],
	spreadsheet: ["xlsx", "xlsm", "xltx", "xltm"],
	presentation: ["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]
} as const

export type SdkPackageKind = keyof typeof SDK_EXTENSIONS

// The package kind the validator opens `path` as, or undefined for an extension it does not validate.
export function sdkPackageKind(path: string): SdkPackageKind | undefined {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()

	return (Object.keys(SDK_EXTENSIONS) as SdkPackageKind[]).find(kind => (SDK_EXTENSIONS[kind] as readonly string[]).includes(extension))
}

export interface SdkError {
	readonly id: string
	readonly description: string
	readonly path: string | null
	readonly part: string | null
}

export interface SdkResult {
	readonly file: string
	readonly fatal?: string
	readonly errors: readonly SdkError[]
}

// A known false positive of the validator: matched by id and description (and part, when given).
export interface AllowEntry {
	readonly id: string
	readonly description: string
	readonly part?: string
	readonly reason: string
}

// Why the validator cannot run here, or undefined when it can.
export function openXmlSdkMissing(): string | undefined {
	if (VALIDATOR === "") return "FILEN_OFFICE_OOXML_VALIDATOR is not set"
	if (!existsSync(VALIDATOR)) return `no validator at ${VALIDATOR}`
	if (spawnSync(DOTNET, ["--list-runtimes"], { stdio: "ignore" }).status !== 0) return `no dotnet host (${DOTNET})`

	return undefined
}

export class OpenXmlSdk {
	private readonly child: ChildProcessByStdio<Writable, Readable, null>
	private readonly lines: AsyncIterator<string>

	constructor() {
		this.child = spawn(DOTNET, [VALIDATOR], {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" }
		})
		this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]()
	}

	async validate(file: string): Promise<SdkResult> {
		if (file.includes("\n")) throw new Error(`Path with a line break: ${file}`)

		this.child.stdin.write(`${file}\n`)

		const line = await this.lines.next()

		if (line.done === true) throw new Error(`The validator exited on ${file}`)

		const result = JSON.parse(line.value) as SdkResult

		if (result.file !== file) throw new Error(`The validator answered for ${result.file}, not ${file}`)

		return result
	}

	async close(): Promise<void> {
		const exited = new Promise<void>(resolve => this.child.once("exit", () => resolve()))

		this.child.stdin.end()
		await exited
	}
}

export function loadAllowlist(): readonly AllowEntry[] {
	return JSON.parse(readFileSync(ALLOW, "utf8")) as AllowEntry[]
}

// Errors by "<part> <id>: <description>", counted (the XPath is left out: an edit shifts it).
export function sdkErrorCounts(result: SdkResult): Map<string, number> {
	const out = new Map<string, number>()

	if (result.fatal !== undefined) out.set(`fatal: ${result.fatal}`, 1)

	for (const error of result.errors) {
		const key = `${error.part ?? "(package)"} ${error.id}: ${error.description}`

		out.set(key, (out.get(key) ?? 0) + 1)
	}

	return out
}

function allowed(key: string, allow: readonly AllowEntry[]): AllowEntry | undefined {
	const [part, rest] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)]
	const id = rest.slice(0, rest.indexOf(": "))
	const description = rest.slice(rest.indexOf(": ") + 2)

	return allow.find(
		entry =>
			entry.id === id &&
			new RegExp(entry.description).test(description) &&
			(entry.part === undefined || new RegExp(entry.part).test(part))
	)
}

// Errors of `after` beyond `before`'s counts that no allowlist entry explains, as "key (before -> after)";
// `used` collects the allowlist entries that explained one.
export function newSdkErrors(
	before: Map<string, number>,
	after: Map<string, number>,
	allow: readonly AllowEntry[],
	used?: Map<AllowEntry, number>
): string[] {
	const out: string[] = []

	for (const [key, count] of after) {
		const was = before.get(key) ?? 0

		if (count <= was) continue
		// A value the source already had wrong (the same attribute, the same value) is copied with the content it
		// is in: a split run or an inserted row repeats its properties.
		if (was > 0 && key.includes(" Sch_AttributeValueDataTypeDetailed: ")) continue
		// So is an element the source already has where the schema allows none (the same element in the same
		// part): a copied run, row or table brings it along.
		if (was > 0 && / Sch_(Invalid|Unexpected)ElementContentExpectingComplex: /.test(key)) continue

		const entry = allowed(key, allow)

		if (entry !== undefined) {
			used?.set(entry, (used.get(entry) ?? 0) + count - was)
			continue
		}

		out.push(`${key} (${was} -> ${count})`)
	}

	return out
}
