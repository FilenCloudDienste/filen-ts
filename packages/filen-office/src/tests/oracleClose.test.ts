import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { UnoSheets } from "./oracles/sheet/unoSheets"

// The oracle children's close() never waits on a child that already exited or ignores EOF: it resolves, kills
// what is left and (UNO) removes the work directory. Stub children are shell scripts.

const CLOSED_WITHIN_MS = 1000

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined
	const late = new Promise<false>(resolve => {
		timer = setTimeout(() => resolve(false), ms)
	})

	try {
		return await Promise.race([promise.then(() => true as const), late])
	} finally {
		clearTimeout(timer)
	}
}

function script(path: string, body: string): string {
	writeFileSync(path, `#!/bin/sh\n${body}\n`)
	chmodSync(path, 0o755)

	return path
}

describe.skipIf(process.platform === "win32")("oracle close()", () => {
	let directory: string

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "filen-office-oracle-close-"))
	})

	afterAll(() => {
		rmSync(directory, { recursive: true, force: true })
	})

	async function openXmlSdk(body: string) {
		vi.stubEnv("FILEN_OFFICE_DOTNET", "/bin/sh")
		vi.stubEnv("FILEN_OFFICE_OOXML_VALIDATOR", script(join(directory, `validator-${Date.now()}.sh`), body))
		vi.resetModules()

		const { OpenXmlSdk } = await import("./oracles/openXmlSdk")

		return new OpenXmlSdk()
	}

	it("OpenXmlSdk resolves at once after the validator exited", async () => {
		// Reads the path and exits without answering, as a validator crashing on a corrupt package does.
		const sdk = await openXmlSdk("read line\nexit 1")

		await expect(sdk.validate("/nowhere.docx")).rejects.toThrow("The validator exited")
		// Its exit is reported (stdout closed) before Node records it; close() comes after both.
		await vi.waitFor(() => expect(Reflect.get(sdk, "child")).toHaveProperty("exitCode", 1))
		expect(await settlesWithin(sdk.close(), CLOSED_WITHIN_MS)).toBe(true)
	})

	it("OpenXmlSdk kills a validator that ignores EOF", async () => {
		const sdk = await openXmlSdk("exec sleep 30")

		expect(await settlesWithin(sdk.close(100), CLOSED_WITHIN_MS)).toBe(true)
	})

	it("UnoSheets kills a runner that ignores EOF, then soffice, and removes its work directory", async () => {
		const resources = join(directory, "Resources")
		const scratch = join(directory, "scratch")

		mkdirSync(resources)
		mkdirSync(scratch)
		// A runner blocked in a UNO call: started, then never reads stdin again.
		script(join(resources, "python"), "echo '{\"ready\":true}'\nexec sleep 30")

		const uno = new UnoSheets(
			{
				path: script(join(directory, "soffice"), "exec sleep 30"),
				version: "0",
				name: "lo-stub",
				resources,
				unoMissing: undefined
			},
			scratch
		)

		expect(readdirSync(scratch)).toHaveLength(1)
		expect(await settlesWithin(uno.close(100), CLOSED_WITHIN_MS)).toBe(true)
		expect(readdirSync(scratch)).toEqual([])
	})
})
