import { readFileSync } from "node:fs"
import { memoryUsage, resourceUsage, threadCpuUsage } from "node:process"
import { bytesSource, type InflateHook } from "../core/opc/index"
import { openXlsx } from "../core/xlsx/read/index"
import { liveHeap } from "./liveHeap"

// One measured open of a workbook in a process of its own (xlsxReadPerf.test.ts runs it): the open and the first
// sheet's parse, as this thread's CPU time; what stays retained (the live heap, liveHeap.ts: two synchronous
// collections leave the backing stores freed off the thread counted); the process's peak RSS. With
// "native", parts inflate through DecompressionStream, as a browser worker host does.

const [file, mode] = process.argv.slice(2)
if (file === undefined) throw new Error("usage: node --expose-gc --import tsx xlsxReadPerfRun.ts <file> [native]")

const inflate: InflateHook = input =>
	ReadableStream.from(input).pipeThrough(
		new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
	)
const bytes = new Uint8Array(readFileSync(file))

const before = await liveHeap()
const rssBefore = memoryUsage.rss()
const cpu = threadCpuUsage()
const started = performance.now()
const opened = await openXlsx(bytesSource(bytes), mode === "native" ? { inflate } : {})

if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`)

const workbook = opened.workbook
const openMs = performance.now() - started
const sheet = await workbook.load(workbook.sheets[workbook.activeTab]?.id ?? 0)
const used = threadCpuUsage(cpu)
const wallMs = performance.now() - started

const after = await liveHeap()

console.log(
	JSON.stringify({
		file,
		mode: mode ?? "fflate",
		cells: sheet.store.cellCount,
		cpuMs: Math.round((used.user + used.system) / 100) / 10,
		openMs: Math.round(openMs),
		wallMs: Math.round(wallMs),
		retainedMB: Math.round((after - before) / 1e5) / 10,
		storeMB: Math.round(sheet.store.estimateBytes() / 1e5) / 10,
		peakRssMB: Math.round(resourceUsage().maxRSS / 1e2) / 10,
		rssBeforeMB: Math.round(rssBefore / 1e5) / 10,
		keep: workbook.sheets.length
	})
)
