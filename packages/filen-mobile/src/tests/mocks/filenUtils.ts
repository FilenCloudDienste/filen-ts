/**
 * Shared mock of @filen/utils for Vitest.
 *
 * Provides Semaphore (no-op) and run (execute with defer support).
 *
 * Usage in test files:
 *
 *   vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))
 *
 * To extend with additional exports:
 *
 *   vi.mock("@filen/utils", async () => ({
 *       ...await import("@/tests/mocks/filenUtils"),
 *       formatBytes: vi.fn()
 *   }))
 */

import { vi } from "vitest"

export class Semaphore {
	async acquire(): Promise<void> {}
	release(): void {}
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export async function run(fn: (defer: (cleanup: () => void) => void) => Promise<any>, opts?: { throw?: boolean }): Promise<any> {
	const cleanups: (() => void)[] = []

	const defer = (cleanup: () => void) => {
		cleanups.push(cleanup)
	}

	try {
		const data = await fn(defer)

		for (const cleanup of cleanups) {
			cleanup()
		}

		return opts?.throw ? data : { success: true, data }
	} catch (error) {
		for (const cleanup of cleanups) {
			try {
				cleanup()
			} catch {}
		}

		if (opts?.throw) {
			throw error
		}

		return { success: false, error }
	}
}

export const createExecutableTimeout = vi.fn()
