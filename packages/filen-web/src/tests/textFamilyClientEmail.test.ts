import { describe, expect, it, vi } from "vitest"

// A message whose parse runs past the job's budget reads as too large, not as a failure; other errors stay errors.

const { outcome } = vi.hoisted((): { outcome: { current: "timeout" | "error" } } => ({ outcome: { current: "timeout" } }))

vi.mock("@/features/preview/workers/textFamily.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/lib/workers/ownedWorker", () => ({ statelessWorker: () => ({}) }))
vi.mock("@/features/preview/lib/workerJob", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/lib/workerJob")>()

	return {
		...actual,
		workerJob: () =>
			Promise.reject(outcome.current === "timeout" ? new actual.WorkerJobTimeoutError("text-family", 20_000) : new Error("broken"))
	}
})

const { readEmailFile } = await import("@/features/preview/lib/textFamilyClient")

describe("readEmailFile", () => {
	it("calls a parse past its budget too large", async () => {
		outcome.current = "timeout"

		expect(await readEmailFile(new Uint8Array(8))).toEqual({ status: "tooLarge" })
	})

	it("rethrows any other failure", async () => {
		outcome.current = "error"

		await expect(readEmailFile(new Uint8Array(8))).rejects.toThrow("broken")
	})
})
