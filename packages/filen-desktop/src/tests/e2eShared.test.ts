import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { within } from "../../scripts/ci/e2e/app.ts"
import { budgetWatchdog, WATCHDOG_CLEANUP_MS, WATCHDOG_EVIDENCE_MS } from "../../scripts/ci/e2e/chains/common.ts"
import type { Findings } from "../../scripts/ci/e2e/findings.ts"
import { posixLegacyDrive } from "../../scripts/ci/e2e/mac.ts"
import { run, runBounded } from "../../scripts/ci/support.ts"

// The harness pieces the deep chains share (chains P, K and the drag-out chain; Linux and macOS).

vi.mock("../../scripts/ci/support.ts", async importOriginal => ({
	...(await importOriginal<typeof import("../../scripts/ci/support.ts")>()),
	processTable: async () => "the process table"
}))

function recordingFindings(order: string[]): Findings {
	return {
		check: async (name, probe) => {
			try {
				await probe()
				order.push(`check passed: ${name}`)

				return true
			} catch (error) {
				order.push(`check failed: ${name}: ${error instanceof Error ? error.message : String(error)}`)

				return false
			}
		},
		must: async () => undefined,
		known: async () => false,
		info: () => undefined,
		attach: name => {
			order.push(`attach ${name}`)
		},
		finish: () => {
			order.push("finish")
		}
	}
}

describe("budgetWatchdog", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("starts nothing without a budget", () => {
		vi.stubEnv("E2E_CHAIN_BUDGET_MINUTES", "")

		expect(budgetWatchdog("chain", recordingFindings([]), { cleanup: async () => undefined })).toBeUndefined()
	})

	it("writes the evidence, fails the check, cleans up, finishes and exits, in that order", async () => {
		vi.useFakeTimers()
		vi.stubEnv("E2E_CHAIN_BUDGET_MINUTES", "2")
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		const order: string[] = []
		const exited = new Promise<void>(resolve => {
			vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				order.push(`exit ${String(code)}`)
				resolve()
			}) as typeof process.exit)
		})
		const watchdog = budgetWatchdog("chain", recordingFindings(order), {
			evidence: async () => {
				order.push("evidence")
			},
			cleanup: async () => {
				order.push("cleanup")
			}
		})

		expect(watchdog).toBeDefined()
		await vi.advanceTimersByTimeAsync(2 * 60_000 - 1)
		expect(order).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		await exited

		expect(order).toEqual([
			"attach chain-processes.txt",
			"evidence",
			"check failed: the chain finished within its 2-minute budget: it did not",
			"cleanup",
			"finish",
			"exit 1"
		])
	})

	it("exits once the evidence and the cleanup ran past their bounds", async () => {
		vi.useFakeTimers()
		vi.stubEnv("E2E_CHAIN_BUDGET_MINUTES", "1")
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		vi.spyOn(console, "log").mockImplementation(() => undefined)

		const order: string[] = []
		let exited = false

		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			order.push(`exit ${String(code)}`)
			exited = true
		}) as typeof process.exit)
		budgetWatchdog("chain", recordingFindings(order), {
			evidence: () => new Promise(() => undefined),
			cleanup: () => new Promise(() => undefined)
		})

		await vi.advanceTimersByTimeAsync(60_000 + WATCHDOG_EVIDENCE_MS - 1)
		expect(order).toEqual(["attach chain-processes.txt"])
		await vi.advanceTimersByTimeAsync(1 + WATCHDOG_CLEANUP_MS)

		expect(exited).toBe(true)
		expect(order).toEqual([
			"attach chain-processes.txt",
			"check failed: the chain finished within its 1-minute budget: it did not",
			"finish",
			"exit 1"
		])
	})

	it("is cleared by the caller before it fires", async () => {
		vi.useFakeTimers()
		vi.stubEnv("E2E_CHAIN_BUDGET_MINUTES", "1")

		const cleanup = vi.fn(async () => undefined)

		clearTimeout(budgetWatchdog("chain", recordingFindings([]), { cleanup }))
		await vi.advanceTimersByTimeAsync(2 * 60_000)

		expect(cleanup).not.toHaveBeenCalled()
	})
})

describe.skipIf(process.platform === "win32")("bounded commands", () => {
	it("gathers the timeout's evidence while the command still runs, then kills it", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined)

		const dir = mkdtempSync(path.join(os.tmpdir(), "filen-bounded-"))
		const pidFile = path.join(dir, "pid")
		let alive = false

		try {
			const result = await runBounded("sh", ["-c", `echo $$ > '${pidFile}'; exec sleep 30`], 300, {
				onTimeout: async () => {
					process.kill(Number(readFileSync(pidFile, "utf8")), 0)
					alive = true
				}
			})

			expect(result.timedOut).toBe(true)
			expect(alive).toBe(true)
			expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("fails a synchronous command by name at its timeout", () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined)

		expect(() => run("sleep", ["30"], { timeoutMs: 200 })).toThrow("sleep timed out after 0 s")
	})
})

describe("within", () => {
	it("hands back the call's value", async () => {
		await expect(within("read", 10_000, Promise.resolve(7))).resolves.toBe(7)
	})

	it("fails by name, in whole seconds, once the time is up", async () => {
		await expect(within("read the recorder", 20, new Promise(() => undefined))).rejects.toThrow("read the recorder: no answer in 0 s")
	})
})

describe("posixLegacyDrive", () => {
	it("creates the empty directory beside the base and reaches it by its real path", () => {
		const base = path.join(mkdtempSync(path.join(os.tmpdir(), "e2e-shared-")), "chain")

		try {
			const drive = posixLegacyDrive(base)

			expect(drive.setting).toBe(`${base}-mnt`)
			expect(drive.root).toBe(realpathSync(`${base}-mnt`))
			expect(statSync(drive.setting).isDirectory()).toBe(true)
		} finally {
			rmSync(path.dirname(base), { recursive: true, force: true })
		}
	})
})
