import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { convert, outputPath, type Office } from "./interop/soffice"

// convert() must not report an output left by an earlier run as this run's conversion.

describe.skipIf(process.platform === "win32")("interop convert() with an older output in the work directory", () => {
	let scratch = ""

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "filen-office-soffice-stale-"))
	})

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true })
	})

	it("reports a failed conversion as failed, not the stale output as ok", async () => {
		// An office that fails without writing anything.
		const fake = join(scratch, "soffice")

		writeFileSync(fake, "#!/bin/sh\necho 'Error: source file could not be loaded' >&2\nexit 1\n")
		chmodSync(fake, 0o755)

		const office: Office = { path: fake, version: "0", name: "lo-0" }
		const outdir = join(scratch, "out")
		const input = join(scratch, "doc.docx")
		const output = outputPath(outdir, input, "pdf")

		mkdirSync(outdir)
		writeFileSync(output, "old output")
		utimesSync(output, new Date(1_000_000), new Date(1_000_000))
		writeFileSync(input, "rewritten save")

		const [result] = await convert(office, join(scratch, "profile"), "pdf", [input], outdir, 5000)

		expect(result).toMatchObject({ input, format: "pdf", ok: false })
		expect(existsSync(output)).toBe(false)
	})

	it("keeps an output newer than its input without running the office", async () => {
		const office: Office = { path: join(scratch, "missing-soffice"), version: "0", name: "lo-0" }
		const outdir = join(scratch, "out")
		const input = join(scratch, "doc.docx")
		const output = outputPath(outdir, input, "pdf")

		mkdirSync(outdir)
		writeFileSync(input, "save")
		utimesSync(input, new Date(1_000_000), new Date(1_000_000))
		writeFileSync(output, "current output")

		const [result] = await convert(office, join(scratch, "profile"), "pdf", [input], outdir, 5000)

		expect(result).toEqual({ input, format: "pdf", ok: true })
		expect(existsSync(output)).toBe(true)
	})
})
