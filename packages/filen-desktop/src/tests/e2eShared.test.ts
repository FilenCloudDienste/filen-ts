import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { within } from "../../scripts/ci/e2e/app.ts"
import { budgetWatchdog } from "../../scripts/ci/e2e/chains/common.ts"
import type { Findings } from "../../scripts/ci/e2e/findings.ts"
import { posixLegacyDrive } from "../../scripts/ci/e2e/mac.ts"

// The harness pieces the deep chains share (chains P, K and the drag-out chain; Linux and macOS).

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
		attach: () => undefined,
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
			"evidence",
			"check failed: the chain finished within its 2-minute budget: it did not",
			"cleanup",
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
