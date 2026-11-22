import { describe, expect, it, vi } from "vitest"
import type { AssistantModel } from "@filen/shared/assistant"
import { createModelRunner } from "@/features/assistant/transform/modelRun"
import type { AssistantModelState } from "@/features/assistant/types"

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }

function fakeRuntime(initial: "ready" | "downloaded" = "ready") {
	let state: AssistantModelState =
		initial === "ready" ? { kind: "ready", model: MODEL } : { kind: "downloaded", model: MODEL, idleUnloaded: false }
	const holds = { taken: 0, released: 0 }
	const model: AssistantModel = {
		contextTokens: 8192,
		specialTokens: [],
		generate: () => Promise.resolve({ content: "", toolCalls: [] })
	}

	return {
		holds,
		runtime: {
			model,
			getState: () => state,
			load: vi.fn(() => {
				state = { kind: "ready", model: MODEL }

				return Promise.resolve()
			}),
			hold: () => {
				holds.taken++

				return () => {
					holds.released++
				}
			}
		},
		fail: () => {
			state = { kind: "error", error: "load-failed", model: MODEL }
		}
	}
}

// Work that settles when its signal aborts (rejecting) or when `finish` is called.
function pendingWork() {
	let finish: (value: string) => void = () => undefined
	const work = (_model: AssistantModel, signal: AbortSignal) =>
		new Promise<string>((resolve, reject) => {
			finish = resolve
			signal.addEventListener("abort", () => {
				reject(new DOMException("aborted", "AbortError"))
			})
		})

	return {
		work,
		finish: (value: string) => {
			finish(value)
		}
	}
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

describe("createModelRunner", () => {
	it("loads a model only on disk, runs the work and releases its hold", async () => {
		const fake = fakeRuntime("downloaded")
		const runner = createModelRunner(fake.runtime)

		await expect(runner.run(new AbortController().signal, "test", () => Promise.resolve("done"))).resolves.toBe("done")
		expect(fake.runtime.load).toHaveBeenCalledTimes(1)
		expect(fake.holds).toEqual({ taken: 1, released: 1 })
	})

	it("stops the one before when a newer request starts", async () => {
		const fake = fakeRuntime()
		const runner = createModelRunner(fake.runtime)
		const first = pendingWork()
		const running = runner.run(new AbortController().signal, "test", first.work)

		await settle()

		const second = pendingWork()
		const next = runner.run(new AbortController().signal, "test", second.work)

		await expect(running).resolves.toEqual({ ok: false, error: "cancelled" })
		await settle()
		second.finish("second")
		await expect(next).resolves.toBe("second")
		expect(fake.holds).toEqual({ taken: 2, released: 2 })
	})

	it("is cancelled by the request's signal", async () => {
		const runner = createModelRunner(fakeRuntime().runtime)
		const controller = new AbortController()
		const running = runner.run(controller.signal, "test", pendingWork().work)

		await settle()
		controller.abort()
		await expect(running).resolves.toEqual({ ok: false, error: "cancelled" })
	})

	it("tells a failure on a model that went away from one that failed", async () => {
		const fake = fakeRuntime()
		const runner = createModelRunner(fake.runtime)

		await expect(runner.run(new AbortController().signal, "test", () => Promise.reject(new Error("boom")))).resolves.toEqual({
			ok: false,
			error: "failed"
		})

		const failing = runner.run(new AbortController().signal, "test", () => {
			fake.fail()

			return Promise.reject(new Error("gone"))
		})

		await expect(failing).resolves.toEqual({ ok: false, error: "model-unavailable" })
	})

	it("refuses everything after signing out", async () => {
		const runner = createModelRunner(fakeRuntime().runtime)

		runner.shutdown()
		await expect(runner.run(new AbortController().signal, "test", () => Promise.resolve("never"))).resolves.toEqual({
			ok: false,
			error: "cancelled"
		})
	})
})
