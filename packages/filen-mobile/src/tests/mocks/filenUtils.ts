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

// Faithful to @filen/utils run(): ALWAYS resolves the full Result object on success —
// `throw: true` only changes the failure path (rethrow instead of a Failure result) —
// and runs deferred cleanups in REVERSE registration order (LIFO) inside a finally,
// exactly like the real implementation.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export async function run(fn: (defer: (cleanup: () => void) => void) => Promise<any>, opts?: { throw?: boolean }): Promise<any> {
	const cleanups: (() => void)[] = []

	const defer = (cleanup: () => void) => {
		cleanups.push(cleanup)
	}

	try {
		const data = await fn(defer)

		return { success: true, data, error: null }
	} catch (error) {
		if (opts?.throw) {
			throw error
		}

		return { success: false, data: null, error }
	} finally {
		for (let i = cleanups.length - 1; i >= 0; i--) {
			try {
				await cleanups[i]?.()
			} catch {}
		}
	}
}

export const createExecutableTimeout = vi.fn()
