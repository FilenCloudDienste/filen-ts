import { describe, expect, it, vi } from "vitest"
import type { ExportWorkerProgress, ExportWorkerResult, StartExportArgs } from "@/features/preview/videoEdit/worker/exportApi"

// The page's handle on one export: its progress reaches the caller only until its answer.
const h = vi.hoisted(() => ({
	answer: null as PromiseWithResolvers<ExportWorkerResult> | null,
	progress: null as ((progress: ExportWorkerProgress) => unknown) | null
}))

vi.mock("@/features/preview/videoEdit/worker/export.worker.ts?worker", () => ({
	default: class extends EventTarget {
		terminate(): void {
			return undefined
		}
	}
}))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: vi.fn() }))
vi.mock("comlink", async importOriginal => ({
	...(await importOriginal<typeof import("comlink")>()),
	wrap: () => ({
		startExport: (_args: StartExportArgs, onProgress: (progress: ExportWorkerProgress) => unknown) => {
			h.progress = onProgress
			h.answer = Promise.withResolvers()

			return h.answer.promise
		},
		cancel: () => Promise.resolve()
	}),
	transfer: <T>(value: T) => value,
	proxy: <T>(value: T) => value
}))

const { exporter } = await import("@/features/preview/videoEdit/exportClient")

const ARGS = { exportId: "e", source: {}, output: {} } as unknown as StartExportArgs
const PROGRESS: ExportWorkerProgress = { outputSeconds: 1, outputDuration: 10, bytesWritten: 100, phase: "exporting" }

const ANSWERS: [string, ExportWorkerResult][] = [
	["done", { status: "done" } as unknown as ExportWorkerResult],
	["cancelled", { status: "cancelled" }]
]

describe("exporter", () => {
	it.each(ANSWERS)("ignores progress that arrives after the export's answer (%s)", async (_label, answer) => {
		const onProgress = vi.fn()
		const run = exporter.run(ARGS, onProgress)

		await vi.waitFor(() => {
			expect(h.progress).not.toBeNull()
		})
		h.progress?.(PROGRESS)
		expect(onProgress).toHaveBeenCalledTimes(1)

		h.answer?.resolve(answer)
		await run.result

		// The callback's own port keeps no order with the result's: its report comes in last.
		h.progress?.({ ...PROGRESS, outputSeconds: 2 })
		expect(onProgress).toHaveBeenCalledTimes(1)
		h.progress = null
	})
})
