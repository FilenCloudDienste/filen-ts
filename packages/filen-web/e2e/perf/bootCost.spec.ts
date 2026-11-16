import { readFileSync, writeFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import { test, expect, CPU_THROTTLE_RATE, neutralizeRemoteConfig, throttleCpu } from "../fixtures"
import { BOOT_SETTLE_TIMEOUT_MS } from "../helpers/listing"
import { SHELL_MARK } from "@/lib/bootSplash"

// What the app costs to boot, for judging a library before it joins the bundle (on request:
// FILEN_WEB_E2E_BOOT_COST=1; Chromium only, it reads the heap and throttles through CDP). Against the built
// preview like every spec, under E2E_CPU_THROTTLE when set. Each sample is a cold signed-out boot in a fresh
// context, so neither the HTTP cache nor a code cache helps it, and no account is needed (run it with --no-deps).
// Per sample: the time to the first real screen (the "filen:shell" mark, dismissBootSplash) and the heap after it,
// performance.measureUserAgentSpecificMemory() where the browser allows it (cross-origin isolated; it resolves at the
// next collection, so a sample can take 20 s), else the page's JS heap after a full collection over CDP. The medians
// are attached; FILEN_WEB_E2E_BOOT_COST_RECORD=<path> also writes them, and FILEN_WEB_E2E_BOOT_COST_BASELINE=<path>
// fails the run when the heap grew more than 2 MB or the shell came more than 20 ms later than that record.

test.skip(process.env["FILEN_WEB_E2E_BOOT_COST"] !== "1", "The boot-cost harness runs on request (FILEN_WEB_E2E_BOOT_COST=1)")
test.use({ injectSession: false })

const SAMPLES = Number(process.env["FILEN_WEB_E2E_BOOT_COST_SAMPLES"] ?? "5")
const HEAP_BAR_MB = 2
const SHELL_BAR_MS = 20
const MB = 1048576

type HeapMethod = "measureUserAgentSpecificMemory" | "cdpJsHeap"

interface BootCost {
	readonly heapMethod: HeapMethod
	readonly cpuThrottle: number
	readonly samples: number
	readonly shellMs: number
	readonly heapMb: number
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)

	return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

async function heap(page: Page): Promise<{ method: HeapMethod; mb: number }> {
	const bytes = await page.evaluate(async () => {
		const measure = Reflect.get(performance, "measureUserAgentSpecificMemory") as (() => Promise<{ bytes: number }>) | undefined

		if (!crossOriginIsolated || measure === undefined) {
			return null
		}

		// Chromium also refuses it (SecurityError) where the browser was not started with it allowed, as Playwright's is.
		return measure
			.call(performance)
			.then(result => result.bytes)
			.catch(() => null)
	})

	if (bytes !== null) {
		return { method: "measureUserAgentSpecificMemory", mb: bytes / MB }
	}

	const cdp = await page.context().newCDPSession(page)

	await cdp.send("HeapProfiler.collectGarbage")

	const usage = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number }

	await cdp.detach()

	return { method: "cdpJsHeap", mb: usage.usedSize / MB }
}

test("boot cost", async ({ browser, browserName, baseURL }, testInfo) => {
	test.skip(browserName !== "chromium", "The heap and the CPU throttle are read through CDP, Chromium's alone")
	test.setTimeout(SAMPLES * 90_000)

	const shellMs: number[] = []
	const heapMb: number[] = []
	const methods = new Set<HeapMethod>()

	for (let sample = 0; sample < SAMPLES; sample++) {
		const context = await browser.newContext({ ...(baseURL !== undefined ? { baseURL } : {}), locale: "en-US" })

		try {
			await neutralizeRemoteConfig(context)

			const page = await context.newPage()

			await throttleCpu(context, page, browserName)
			await page.goto("/")
			await page.waitForFunction(mark => performance.getEntriesByName(mark, "mark").length > 0, SHELL_MARK, {
				timeout: BOOT_SETTLE_TIMEOUT_MS
			})

			shellMs.push(await page.evaluate(mark => performance.getEntriesByName(mark, "mark")[0]?.startTime ?? Number.NaN, SHELL_MARK))

			const measured = await heap(page)

			methods.add(measured.method)
			heapMb.push(measured.mb)
		} finally {
			await context.close()
		}
	}

	const [heapMethod] = methods

	expect(methods.size, "every sample read the heap the same way").toBe(1)

	if (heapMethod === undefined) {
		throw new Error("no samples (FILEN_WEB_E2E_BOOT_COST_SAMPLES)")
	}

	const cost: BootCost = {
		heapMethod,
		cpuThrottle: CPU_THROTTLE_RATE,
		samples: SAMPLES,
		shellMs: median(shellMs),
		heapMb: median(heapMb)
	}
	const report = JSON.stringify(cost, null, "\t")

	await testInfo.attach("boot-cost", { body: report, contentType: "application/json" })

	const recordPath = process.env["FILEN_WEB_E2E_BOOT_COST_RECORD"]

	if (recordPath !== undefined && recordPath !== "") {
		writeFileSync(recordPath, report)
	}

	const baselinePath = process.env["FILEN_WEB_E2E_BOOT_COST_BASELINE"]

	if (baselinePath === undefined || baselinePath === "") {
		return
	}

	const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BootCost

	expect({ heapMethod: baseline.heapMethod, cpuThrottle: baseline.cpuThrottle }, "the baseline was measured the same way").toEqual({
		heapMethod: cost.heapMethod,
		cpuThrottle: cost.cpuThrottle
	})
	expect(cost.heapMb - baseline.heapMb, `heap ${report}`).toBeLessThanOrEqual(HEAP_BAR_MB)
	expect(cost.shellMs - baseline.shellMs, `time to shell ${report}`).toBeLessThanOrEqual(SHELL_BAR_MS)
})
