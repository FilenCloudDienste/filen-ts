import { execFile } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AnyDirWithContext, AnyFile, AnyNormalDir, ManagedFuture } from "@filen/sdk-rs"
import type { DesktopSdkVariant } from "@filen/shared/desktop"
import { ubrnOf } from "@filen/shared/sdkShapes"
import { parseEnvelope } from "@filen/shared/session"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { builtAddon, installedAddon, sdkPackageDir } from "../../scripts/stageNapi.ts"
import { isCancelled } from "../native/transferErrors.ts"
import { type TransferClient, type TransferSdk, transferBindings } from "../native/transfers.ts"

// The transfer adapter against the real napi addon: FILEN_DESKTOP_NAPI_DIR (a filen-rs `build:napi` output) when
// set, else the installed platform package, which must carry the transfer exports; a local build without them is
// skipped. Offline: the client is built from a stringified config with dummy values, and every transfer runs on an
// already aborted ManagedAbortController, which rejects Cancelled before any request, but only after the arguments
// converted.

const arch = process.arch === "arm64" || process.arch === "x64" ? process.arch : null
const napiDir = process.env["FILEN_DESKTOP_NAPI_DIR"]
const fromDir = napiDir !== undefined && napiDir.length > 0
const addonFile = arch === null ? null : fromDir ? builtAddon(napiDir, arch) : installedAddon(arch)
const typingsFile = fromDir ? path.join(napiDir, "index.d.ts") : path.join(sdkPackageDir(), "node", "index.d.ts")

type Addon = TransferSdk & {
	UnauthJsClient: { fromConfig(config: object): { fromStringified(client: object): object } }
}

const ROOT_UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

function stringifiedClient(): object {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

	return {
		email: "transfers@example.com",
		userId: 1n,
		rootUuid: ROOT_UUID,
		authInfo: "0".repeat(64),
		privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
		apiKey: "0".repeat(64),
		authVersion: 3
	}
}

function load(): { addon: Addon; client: object } | { skipped: string } {
	if (addonFile === null) {
		return { skipped: `no addon for ${process.platform}-${process.arch}` }
	}

	const addon = createRequire(import.meta.url)(addonFile) as Addon
	const client = addon.UnauthJsClient.fromConfig({}).fromStringified(stringifiedClient())

	return fromDir && transferBindings(addon, client) === null ? { skipped: `${addonFile} lacks the transfer exports` } : { addon, client }
}

const loaded = load()
const skipped = "skipped" in loaded ? loaded.skipped : null

// The D3 wasm fixtures: the shapes the page sends.
const FIXTURES = path.join(import.meta.dirname, "..", "..", "..", "filen-shared", "src", "tests", "fixtures", "sdkShapes", "wasm")

function wasmFixture(name: string): unknown {
	return parseEnvelope(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"))
}

const FILES: Readonly<Record<string, DesktopSdkVariant>> = {
	file: "AnyFile.File",
	fileRawMeta: "AnyFile.File",
	fileNoHash: "AnyFile.File",
	// A file inside a shared directory: the page sends it as a plain File, without a stable uuid.
	fileNoStableUuid: "AnyFile.File",
	trashedFile: "AnyFile.File",
	sharedFile: "AnyFile.Shared",
	linkedFile: "AnyFile.Linked"
}

const NORMAL_DIRS = ["dir", "dirColored", "dirEncryptedMeta", "dirRawMeta"] as const

const CONTEXT_DIRS: Readonly<Record<string, DesktopSdkVariant>> = {
	sharedDirWithContext: "AnyDirWithContext.Shared.Dir",
	sharedRootWithContext: "AnyDirWithContext.Shared.Root",
	linkedDirWithContext: "AnyDirWithContext.Linked.Dir",
	linkedRootWithContext: "AnyDirWithContext.Linked.Root",
	linkedDirWithPassword: "AnyDirWithContext.Linked.Dir"
}

// The napi typings, read as the converter's output must match them: interfaces (fields and whether each is
// optional), tagged unions ({ tag, inner: [T] } or a unit { tag }), declared enums and plain aliases.
interface Typings {
	interfaces: Map<string, Map<string, { type: string; optional: boolean }>>
	unions: Map<string, Map<string, string | null>>
	enums: Set<string>
	aliases: Map<string, string>
}

function parseTypings(source: string): Typings {
	const typings: Typings = { interfaces: new Map(), unions: new Map(), enums: new Set(), aliases: new Map() }

	for (const match of source.matchAll(/^export interface (\w+) \{\n([\s\S]*?)\n\}/gm)) {
		const fields = new Map<string, { type: string; optional: boolean }>()

		for (const line of match[2]?.split("\n") ?? []) {
			const field = /^\s+(\w+)(\?)?: ([^(]+?);?$/.exec(line)

			if (field?.[1] !== undefined && field[3] !== undefined) {
				fields.set(field[1], { type: field[3].replace(/ \| undefined$/, ""), optional: field[2] === "?" })
			}
		}

		typings.interfaces.set(match[1] ?? "", fields)
	}

	for (const match of source.matchAll(/^export type (\w+) =\n((?:\s+\| \{.*\}\n?)+)/gm)) {
		const variants = new Map<string, string | null>()

		for (const variant of match[2]?.matchAll(/\{ tag: '(\w+)'(?:; inner: \[(\w+)\])? \}/g) ?? []) {
			variants.set(variant[1] ?? "", variant[2] ?? null)
		}

		typings.unions.set(match[1] ?? "", variants)
	}

	for (const match of source.matchAll(/^export declare enum (\w+) \{/gm)) {
		typings.enums.add(match[1] ?? "")
	}

	for (const match of source.matchAll(/^export type (\w+) = (\w+)$/gm)) {
		typings.aliases.set(match[1] ?? "", match[2] ?? "")
	}

	return typings
}

// Every mismatch between `value` and the typings' `type`, as "path: reason".
function mismatches(typings: Typings, type: string, value: unknown, at: string): string[] {
	const resolved = typings.aliases.get(type) ?? type

	if (resolved !== type) {
		return mismatches(typings, resolved, value, at)
	}

	switch (type) {
		case "string":
		case "bigint":
		case "boolean":
		case "number":
			return typeof value === type ? [] : [`${at}: expected a ${type}`]
		case "Uint8Array":
			return value instanceof Uint8Array ? [] : [`${at}: expected a Uint8Array`]
	}

	if (typings.enums.has(type)) {
		return typeof value === "number" || typeof value === "string" ? [] : [`${at}: expected a ${type}`]
	}

	const fields = typings.interfaces.get(type)

	if (fields !== undefined) {
		if (typeof value !== "object" || value === null) {
			return [`${at}: expected a ${type}`]
		}

		const record = value as Record<string, unknown>
		const found = Object.keys(record)
			.filter(key => !fields.has(key))
			.map(key => `${at}.${key}: not in ${type}`)

		for (const [key, field] of fields) {
			if (record[key] === undefined) {
				if (!field.optional) {
					found.push(`${at}.${key}: missing from ${type}`)
				}
			} else {
				found.push(...mismatches(typings, field.type, record[key], `${at}.${key}`))
			}
		}

		return found
	}

	const variants = typings.unions.get(type)

	if (variants !== undefined) {
		const { tag, inner, ...rest } = value as { tag?: unknown; inner?: unknown }
		const payload = typeof tag === "string" ? variants.get(tag) : undefined

		if (payload === undefined) {
			return [`${at}.tag: not a ${type} variant`]
		}

		const extra = Object.keys(rest).map(key => `${at}.${key}: not in ${type}`)

		if (payload === null) {
			return inner === undefined ? extra : [...extra, `${at}.inner: ${type}.${String(tag)} has no payload`]
		}

		return Array.isArray(inner) && inner.length === 1
			? [...extra, ...mismatches(typings, payload, inner[0], `${at}.inner.0`)]
			: [...extra, `${at}.inner: expected one ${payload}`]
	}

	return [`${at}: ${type} is not in the typings`]
}

describe.skipIf(skipped !== null)(`the napi transfer surface${skipped === null ? "" : ` (skipped: ${skipped})`}`, () => {
	// The body is collected even when skipped: nothing here may touch the addon.
	const { addon, client } = loaded as { addon: Addon; client: object }
	const bindings = skipped === null ? transferBindings(addon, client) : null
	const transfers = bindings?.client as TransferClient
	const typings = parseTypings(existsSync(typingsFile) ? readFileSync(typingsFile, "utf8") : "")
	let directory = ""

	beforeAll(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "filen-transfers-addon-"))
	})

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true })
	})

	function aborted(): ManagedFuture {
		const controller = new addon.ManagedAbortController()

		controller.abort()

		return { abortSignal: controller.signal(), pauseSignal: new addon.PauseSignal() }
	}

	// A call that converted its arguments rejects Cancelled; one that did not throws or rejects something else.
	async function outcome(call: () => Promise<unknown>): Promise<string> {
		try {
			await call()

			return "resolved"
		} catch (error) {
			return isCancelled(addon, error) ? "cancelled" : `refused: ${error instanceof Error ? error.message : String(error)}`
		}
	}

	const dirCallback = {
		onQueryDownloadProgress: () => undefined,
		onScanProgress: () => undefined,
		onScanErrors: () => undefined,
		onScanComplete: () => undefined,
		onDownloadUpdate: () => undefined,
		onDownloadErrors: () => undefined
	}

	function upload(parent: AnyNormalDir): Promise<string> {
		return outcome(() =>
			transfers.uploadFile(
				{ parent, name: undefined, created: undefined, modified: undefined, mime: undefined, noExif: false, noExifOverride: false },
				typingsFile,
				{ onUpdate: () => undefined },
				aborted()
			)
		)
	}

	it("exports every TransferClient method and the managed-future classes", () => {
		expect(bindings).not.toBeNull()

		const controller = new addon.ManagedAbortController()
		const signal = controller.signal() as { aborted(): boolean }

		expect(signal.aborted()).toBe(false)
		controller.abort()
		expect(signal.aborted()).toBe(true)

		const pause = new addon.PauseSignal() as { isPaused(): boolean; pause(): void; resume(): void }

		pause.pause()
		expect(pause.isPaused()).toBe(true)
		pause.resume()
		expect(pause.isPaused()).toBe(false)
	})

	it("declares the transfer calls the registry makes, with a required managedFuture", () => {
		const source = readFileSync(typingsFile, "utf8")

		for (const signature of [
			"downloadFileToPath(file: AnyFile, filePath: string, callback: JsFileDownloadCallback | undefined, managedFuture: ManagedFuture,",
			"uploadFile(params: FileBuilderParamsOptionalName, filePath: string, callback: JsFileUploadCallback | undefined, managedFuture: ManagedFuture,",
			"downloadDirRecursively(dirPath: string, callback: JsDirDownloadCallback, target: AnyDirWithContext, managedFuture: ManagedFuture,",
			"uploadDirRecursively(dirPath: string, callback: JsDirUploadCallback, target: Dir, managedFuture: ManagedFuture,",
			"listDirRecursiveWithPaths(dir: AnyDirWithContext, listDirProgressCallback: DirContentDownloadProgressCallback | undefined, scanErrorCallback: DirContentDownloadErrorCallback,",
			"createDir(parent: AnyNormalDir, name: string,",
			"root(): Root"
		]) {
			expect(source).toContain(signature)
		}
	})

	it("matches the converter's output to the addon's typings", () => {
		const cases: [string, DesktopSdkVariant, string][] = [
			...Object.entries(FILES).map(([name, variant]): [string, DesktopSdkVariant, string] => [name, variant, "AnyFile"]),
			...NORMAL_DIRS.map((name): [string, DesktopSdkVariant, string] => [name, "AnyNormalDir.Dir", "AnyNormalDir"]),
			...NORMAL_DIRS.map((name): [string, DesktopSdkVariant, string] => [name, "AnyDirWithContext.Normal.Dir", "AnyDirWithContext"]),
			["root", "AnyNormalDir.Root", "AnyNormalDir"],
			["root", "AnyDirWithContext.Normal.Root", "AnyDirWithContext"],
			...Object.entries(CONTEXT_DIRS).map(([name, variant]): [string, DesktopSdkVariant, string] => [
				name,
				variant,
				"AnyDirWithContext"
			])
		]

		for (const [name, variant, type] of cases) {
			expect(mismatches(typings, type, ubrnOf(variant, wasmFixture(name)), name)).toEqual([])
		}
	})

	it("accepts every converted file", async () => {
		for (const [name, variant] of Object.entries(FILES)) {
			const file = ubrnOf(variant, wasmFixture(name)) as AnyFile

			expect([
				name,
				await outcome(() =>
					transfers.downloadFileToPath(file, path.join(directory, name), { onUpdate: () => undefined }, aborted())
				)
			]).toEqual([name, "cancelled"])
		}
	})

	it("accepts every converted directory as a download target and a normal one as an upload parent and target", async () => {
		for (const [name, variant] of Object.entries(CONTEXT_DIRS)) {
			const dir = ubrnOf(variant, wasmFixture(name)) as AnyDirWithContext

			expect([
				name,
				await outcome(() => transfers.downloadDirRecursively(path.join(directory, name), dirCallback, dir, aborted()))
			]).toEqual([name, "cancelled"])
		}

		for (const name of NORMAL_DIRS) {
			const wasm = wasmFixture(name)
			const context = ubrnOf("AnyDirWithContext.Normal.Dir", wasm) as AnyDirWithContext
			const parent = ubrnOf("AnyNormalDir.Dir", wasm) as Extract<AnyNormalDir, { tag: "Dir" }>

			expect([
				name,
				await outcome(() => transfers.downloadDirRecursively(path.join(directory, name), dirCallback, context, aborted()))
			]).toEqual([name, "cancelled"])
			expect([name, await upload(parent)]).toEqual([name, "cancelled"])
			expect([
				name,
				await outcome(() =>
					transfers.uploadDirRecursively(
						directory,
						{
							onScanProgress: () => undefined,
							onScanErrors: () => undefined,
							onScanComplete: () => undefined,
							onUploadUpdate: () => undefined,
							onUploadErrors: () => undefined
						},
						parent.inner[0],
						aborted()
					)
				)
			]).toEqual([name, "cancelled"])
		}
	})

	it("takes a uuid-only Root as the root and as any other upload parent", async () => {
		const root = ubrnOf("AnyNormalDir.Root", { uuid: ROOT_UUID }) as AnyNormalDir

		expect(transfers.root()).toEqual(root.inner[0])
		expect(await upload(root)).toBe("cancelled")
		expect(await upload(ubrnOf("AnyNormalDir.Root", wasmFixture("root")) as AnyNormalDir)).toBe("cancelled")
		expect(
			await outcome(() =>
				transfers.downloadDirRecursively(
					directory,
					dirCallback,
					ubrnOf("AnyDirWithContext.Normal.Root", { uuid: ROOT_UUID }) as AnyDirWithContext,
					aborted()
				)
			)
		).toBe("cancelled")
	})

	it("refuses a file missing a field before it is cancelled", async () => {
		const file = ubrnOf("AnyFile.File", wasmFixture("file")) as AnyFile

		delete (file.inner[0] as unknown as Record<string, unknown>)["region"]

		expect(await outcome(() => transfers.downloadFileToPath(file, path.join(directory, "missing"), undefined, aborted()))).toMatch(
			/^refused: .*region/
		)
	})

	const electron = (createRequire(import.meta.url)("electron") as string | undefined) ?? ""
	const headless = process.platform === "linux" && process.env["DISPLAY"] === undefined && process.env["WAYLAND_DISPLAY"] === undefined

	// The host runs the addon in a utilityProcess, inside Electron's V8 memory cage: bytes cross there too.
	it.skipIf(!existsSync(electron) || headless)(
		"converts and cancels in an Electron utilityProcess",
		async () => {
			const main = path.join(directory, "main.mjs")
			const child = path.join(directory, "child.mjs")
			const input = path.join(directory, "input.json")
			const files = ["file", "fileRawMeta"].map(name => ubrnOf("AnyFile.File", wasmFixture(name)))

			await writeFile(
				input,
				JSON.stringify({ addon: addonFile, client: stringifiedClient(), files, out: directory }, (_key, value: unknown) =>
					typeof value === "bigint"
						? { $bigint: value.toString() }
						: value instanceof Uint8Array
							? { $bytes: Buffer.from(value).toString("hex") }
							: value
				)
			)
			await writeFile(main, ELECTRON_MAIN)
			await writeFile(child, ELECTRON_CHILD)

			const result = await new Promise<string>((resolve, reject) => {
				execFile(
					electron,
					[main],
					{
						env: {
							...process.env,
							ELECTRON_RUN_AS_NODE: undefined,
							D12_CHILD: child,
							D12_INPUT: input,
							D12_USER_DATA: directory
						},
						timeout: 60_000
					},
					(error, stdout, stderr) => {
						if (error !== null) {
							reject(new Error(`${error.message}\n${stderr}`))
						} else {
							resolve(stdout)
						}
					}
				)
			})
			const reply = JSON.parse(result.trim().split("\n").at(-1) ?? "{}") as unknown

			expect(reply).toEqual({
				root: { uuid: ROOT_UUID },
				outcomes: ["Cancelled", "Cancelled"],
				hash: { type: "Uint8Array", length: 32 },
				raw: { type: "Uint8Array" }
			})
		},
		60_000
	)
})

// Electron main: forks the child as a utilityProcess, prints what it posts. userData points at the test's temp
// directory, so no profile is touched.
const ELECTRON_MAIN = `import { app, utilityProcess } from "electron"
app.setPath("userData", process.env.D12_USER_DATA)
app.dock?.hide()
app.whenReady().then(() => {
	const child = utilityProcess.fork(process.env.D12_CHILD, [], { env: process.env, stdio: "inherit" })
	child.on("message", message => {
		process.stdout.write(JSON.stringify(message) + "\\n")
		app.exit(0)
	})
	child.on("exit", code => app.exit(code === 0 ? 0 : 1))
})
`

// The utilityProcess: loads the addon, builds the offline client, sends converted files (Uint8Array hash and raw
// metadata included) through aborted downloads, and posts the outcomes.
const ELECTRON_CHILD = `import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
const input = JSON.parse(readFileSync(process.env.D12_INPUT, "utf8"), (_key, value) =>
	value !== null && typeof value === "object" && "$bigint" in value
		? BigInt(value.$bigint)
		: value !== null && typeof value === "object" && "$bytes" in value
			? Uint8Array.from(Buffer.from(value.$bytes, "hex"))
			: value
)
const sdk = createRequire(import.meta.url)(input.addon)
const client = sdk.UnauthJsClient.fromConfig({}).fromStringified(input.client)
const kindOf = error =>
	sdk.FilenSdkError.hasInner(error)
		? Object.keys(sdk.ErrorKind).find(key => sdk.ErrorKind[key] === sdk.FilenSdkError.getInner(error).kind())
		: String(error && error.message)
const outcomes = []
for (const [index, file] of input.files.entries()) {
	const controller = new sdk.ManagedAbortController()
	controller.abort()
	try {
		await client.downloadFileToPath(file, path.join(input.out, "electron-" + index), undefined, {
			abortSignal: controller.signal(),
			pauseSignal: new sdk.PauseSignal()
		})
		outcomes.push("resolved")
	} catch (error) {
		outcomes.push(kindOf(error))
	}
}
const meta = input.files[0].inner[0].meta.inner[0]
const raw = input.files[1].inner[0].meta.inner[0]
process.parentPort.postMessage({
	root: client.root(),
	outcomes,
	hash: { type: meta.hash.constructor.name, length: meta.hash.length },
	raw: { type: raw.constructor.name }
})
`
