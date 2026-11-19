import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { budget } from "./timing"

// Hostile and very large .docx converted to .odt: each refuses with a typed reason or converts, in bounded time and
// memory (a browser worker past its memory is a crash, not a refusal). Each converts in a process of its own, whose
// peak resident size, the array buffers it still holds once collected, and the CPU time of its thread (not the wall
// clock, which counts whatever else shares the machine) are measured.

const PEAK = 1024 * 1024 * 1024
const cell = (text: string): string => `<w:tc>${p(text)}</w:tc>`
const grid = (n: number): string => `<w:tblGrid>${'<w:gridCol w:w="150"/>'.repeat(n)}</w:tblGrid>`
const scratch = mkdtempSync(join(tmpdir(), "filen-office-hostile-"))
const convert = fileURLToPath(new URL("../core/convert/text/index.ts", import.meta.url))
const RUN = `
import { readFileSync } from "node:fs"
import { convertText } from ${JSON.stringify(convert)}
const cpu = () => { const u = process.threadCpuUsage?.() ?? process.cpuUsage(); return (u.user + u.system) / 1000 }
const started = cpu()
const converted = await convertText(new Uint8Array(readFileSync(process.argv[1])), "docx", "odt")
const ms = cpu() - started
globalThis.gc?.()
console.log(JSON.stringify({ result: converted.ok ? "ok" : converted.refusal.reason, ms, peak: process.resourceUsage().maxRSS * 1024, buffers: process.memoryUsage().arrayBuffers }))
`

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// The wall clock a case's process may run before it is killed: spawnSync blocks the worker, so the test's own timeout
// cannot fire while a conversion hangs. Generous over the CPU allowance, as it also counts start-up and the machine's
// other work.
function wallCap(time: number): number {
	return budget(time) * 3 + 30_000
}

function outcome(name: string, spec: SyntheticDocx, time: number): { result: string; ms: number; peak: number; buffers: number } {
	const file = join(scratch, `${name}.docx`)

	writeFileSync(file, buildDocx(spec))

	const cap = wallCap(time)
	const run = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", RUN, file], {
		encoding: "utf8",
		timeout: cap,
		killSignal: "SIGKILL"
	})

	if (run.error !== undefined || run.signal !== null)
		throw new Error(
			`${name}: conversion process ${run.signal === null ? "failed" : `killed by ${run.signal}`} (wall cap ${String(cap)} ms): ${run.error?.message ?? run.stderr.slice(0, 2000)}`
		)

	if (run.status !== 0) throw new Error(`${name}: conversion process exited with ${String(run.status)}: ${run.stderr.slice(0, 2000)}`)

	return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as { result: string; ms: number; peak: number; buffers: number }
}

// Each case: the file, its outcome, and the time it may take (a hostile one 2 s; a long legitimate one more).
const CASES: Readonly<Record<string, readonly [() => SyntheticDocx, string, number?]>> = {
	// One 240 KB header referenced by 2000 sections of their own page size: a master page each.
	headerFan: [
		() => {
			let body = ""

			for (let k = 0; k < 2000; k++)
				body += `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="${String(11906 + k)}" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>s${String(k)}</w:t></w:r></w:p>`

			return {
				body: `${body}<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`,
				headers: { rIdH: `<w:p><w:r><w:t>${"header text ".repeat(20_000)}</w:t></w:r></w:p>` }
			}
		},
		"tooLarge"
	],
	// Long plain tables (a mail merge, a data export), written a few rows at a time: 30 000 and 100 000 rows of 10 cells.
	rows30k: [
		() => ({
			body: `<w:tbl>${grid(10)}${`<w:tr>${Array.from({ length: 10 }, (_, k) => cell(`v${String(k)}`)).join("")}</w:tr>`.repeat(30_000)}</w:tbl>`
		}),
		"ok",
		10_000
	],
	rows100k: [
		() => ({
			body: `<w:tbl>${grid(10)}${`<w:tr>${Array.from({ length: 10 }, (_, k) => cell(`v${String(k)}`)).join("")}</w:tr>`.repeat(100_000)}</w:tbl>`
		}),
		"ok",
		20_000
	],
	// One cell spanning down all 100 000 rows: the rows wait on its span, held as they are written.
	rowsMerged: [
		() => ({
			body: `<w:tbl>${grid(2)}<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p("m")}</w:tc>${cell("a")}</w:tr>${`<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>${cell("b")}</w:tr>`.repeat(100_000)}</w:tbl>`
		}),
		"ok",
		20_000
	],
	// 300 sections with that header: 72 MB of copies, written.
	headerFan300: [
		() => {
			let body = ""

			for (let k = 0; k < 300; k++)
				body += `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="${String(11906 + k)}" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>s${String(k)}</w:t></w:r></w:p>`

			return {
				body: `${body}<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`,
				headers: { rIdH: `<w:p><w:r><w:t>${"header text ".repeat(20_000)}</w:t></w:r></w:p>` }
			}
		},
		"ok"
	],
	// A body past what is converted (390 000 rows): refused before it is parsed.
	cellsHuge: [
		() => ({
			body: `<w:tbl>${grid(10)}${`<w:tr>${Array.from({ length: 10 }, (_, k) => cell(`v${String(k)}`)).join("")}</w:tr>`.repeat(390_000)}</w:tbl>`
		}),
		"tooLarge"
	],
	// One paragraph of 20 million "a" and doubled spaces (60 MB): a text:s for each pair, refused as it grows.
	doubledSpaces: [() => ({ body: `<w:p><w:r><w:t xml:space="preserve">${"a  ".repeat(20_000_000)}</w:t></w:r></w:p>` }), "tooLarge"],
	// 150 000 paragraphs of tracked deletions of 400 characters (728 KB zipped, 77 MB of XML: more time than a hostile
	// file's 2 s, as a long document): each change region held as bytes once written, and charged.
	trackedDeletions: [
		() => ({
			body: Array.from(
				{ length: 150_000 },
				(_, k) =>
					`<w:p><w:del w:id="${String(k)}" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r><w:delText>${"x".repeat(400)}</w:delText></w:r></w:del></w:p>`
			).join("")
		}),
		"ok",
		3000
	],
	// A grid of 10 000 columns no row reaches, in eight tables.
	gridMany: [
		() => ({ body: `<w:tbl>${grid(5000)}${`<w:tr>${cell("")}</w:tr>`.repeat(3000)}</w:tbl>${p("between").repeat(70)}`.repeat(8) }),
		"ok"
	]
}

describe("docx → odt in bounded memory", () => {
	for (const [name, [make, expected, time = 2000]] of Object.entries(CASES))
		it(`${name}: ${expected}, in under ${String(time / 1000)} s and 1 GiB`, { timeout: wallCap(time) + 120_000 }, () => {
			const { result, ms, peak, buffers } = outcome(name, make(), time)

			process.stdout.write(`${name}: ${result} ${String(Math.round(ms))} ms, peak ${String(Math.round(peak / 1e6))} MB\n`)

			expect(result).toBe(expected)
			expect(ms).toBeLessThan(budget(time))
			expect(peak).toBeLessThan(PEAK)
			expect(buffers).toBeLessThan(256 * 1024 * 1024)
		})
})
