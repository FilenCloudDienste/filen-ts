import { describe, expect, it, vi } from "vitest"
import { savePortWriter, type SavePortEnd } from "@filen/shared/savePort"

// A jobs worker in this thread, answering a run as `behaviour` says; its messages reach the page a turn later.
const state = vi.hoisted((): { behaviour: "writeThenWaitForAbort" | "refuse"; terminated: number } => ({
	behaviour: "refuse",
	terminated: 0
}))

vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: () => undefined }))
vi.mock("@/features/presentation/workers/presentationJobs.worker.ts?worker", () => ({
	default: class {
		readonly #listeners: ((event: { readonly data: unknown }) => void)[] = []

		addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void {
			if (type === "message") this.#listeners.push(listener)
		}

		postMessage(message: { readonly t?: unknown; readonly output?: unknown }): void {
			if (message.t === "abort") this.#post({ t: "done", id: 1, outcome: { kind: "refused", reason: "aborted", detail: "job" } })
			if (message.t !== "run") return

			const output = savePortWriter(message.output as SavePortEnd)

			output.announce()

			if (state.behaviour === "refuse") {
				output.abort("refused")
				this.#post({ t: "done", id: 1, outcome: { kind: "refused", reason: "wrongPassword" } })

				return
			}

			void output.write(new Uint8Array([1, 2, 3])).then(() => output.close())
		}

		terminate(): void {
			state.terminated++
		}

		#post(data: unknown): void {
			void Promise.resolve().then(() => {
				for (const listener of this.#listeners) listener({ data })
			})
		}
	}
}))

const { runPresentationJob, PresentationJobRefused } = await import("@/features/presentation/lib/presentationJobs")

const session = { jobsPort: () => Promise.resolve() }
const request = { layout: "slides", includeHidden: false, protect: false } as const

describe("runPresentationJob", () => {
	it("rejects with the sink's error and ends the worker when a write fails", async () => {
		const failure = new Error("disk full")

		state.behaviour = "writeThenWaitForAbort"
		state.terminated = 0

		await expect(
			runPresentationJob(
				"pdf",
				request,
				session,
				{ write: () => Promise.reject(failure), close: () => Promise.resolve() },
				{ signal: new AbortController().signal }
			)
		).rejects.toBe(failure)
		expect(state.terminated).toBe(1)
	})

	it("still rejects a refused job with its refusal", async () => {
		state.behaviour = "refuse"
		state.terminated = 0

		const result = runPresentationJob(
			"pdf",
			request,
			session,
			{ write: () => Promise.resolve(), close: () => Promise.resolve() },
			{ signal: new AbortController().signal }
		)

		await expect(result).rejects.toBeInstanceOf(PresentationJobRefused)
		await expect(result).rejects.toMatchObject({ outcome: { reason: "wrongPassword" } })
		expect(state.terminated).toBe(1)
	})
})
