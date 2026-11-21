import { describe, expect, it, vi } from "vitest"
import type { AssistantGenerateRequest, AssistantModel } from "@filen/shared/assistant"
import { createAssistantTransformer } from "@/features/assistant/transform/run"
import type { AssistantModelState, AssistantTransformRequest } from "@/features/assistant/types"

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }

// A runtime whose model writes `chunks` one by one, each a step of the returned trigger.
function fakeRuntime(initial: AssistantModelState["kind"] = "ready") {
	let state: AssistantModelState =
		initial === "ready" ? { kind: "ready", model: MODEL } : { kind: "downloaded", model: MODEL, idleUnloaded: false }
	const requests: AssistantGenerateRequest[] = []
	const holds = { taken: 0, released: 0 }
	let pending: { resolve: (content: string) => void; signal: AbortSignal } | null = null
	const model: AssistantModel = {
		contextTokens: 8192,
		specialTokens: [],
		generate: (request, { signal, onText }) => {
			requests.push(request)
			onText?.("Hi")

			return new Promise((resolve, reject) => {
				pending = {
					resolve: content => {
						resolve({ content, toolCalls: [] })
					},
					signal: signal as AbortSignal
				}
				;(signal as AbortSignal).addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"))
				})
			})
		}
	}
	const runtime = {
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
	}

	return {
		runtime,
		requests,
		holds,
		finish: (content: string) => {
			pending?.resolve(content)
		},
		fail: () => {
			state = { kind: "error", error: "load-failed", model: MODEL }
		}
	}
}

function request(overrides: Partial<AssistantTransformRequest> = {}): AssistantTransformRequest {
	return {
		kind: "rewrite",
		text: "hello world ",
		language: "en",
		signal: new AbortController().signal,
		onText: () => undefined,
		...overrides
	}
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

describe("createAssistantTransformer", () => {
	it("loads a model on disk, holds it for the generation and returns the raw output", async () => {
		const fake = fakeRuntime("downloaded")
		const transformer = createAssistantTransformer(fake.runtime)
		const seen: string[] = []
		const running = transformer.run(request({ onText: text => seen.push(text) }))

		await settle()
		expect(fake.runtime.load).toHaveBeenCalledOnce()
		expect(fake.holds).toEqual({ taken: 1, released: 0 })
		expect(fake.requests[0]?.slot).toBe("extraction")
		fake.finish("Hello, world &amp; a\\.b")

		await expect(running).resolves.toEqual({ ok: true, text: "Hello, world &amp; a\\.b ", truncated: false, foreignLinks: [] })
		expect(seen).toEqual(["Hi "])
		expect(fake.holds).toEqual({ taken: 1, released: 1 })
	})

	it("refuses a selection too long for the kind before anything loads", async () => {
		const fake = fakeRuntime("downloaded")
		const transformer = createAssistantTransformer(fake.runtime)

		await expect(transformer.run(request({ kind: "translate", text: "word ".repeat(600) }))).resolves.toEqual({
			ok: false,
			error: "too-long"
		})
		expect(fake.runtime.load).not.toHaveBeenCalled()
		expect(fake.holds.taken).toBe(0)
	})

	it("reports a model that did not load", async () => {
		const fake = fakeRuntime("downloaded")

		fake.runtime.load.mockImplementation(() => {
			fake.fail()

			return Promise.resolve()
		})

		await expect(createAssistantTransformer(fake.runtime).run(request())).resolves.toEqual({ ok: false, error: "model-unavailable" })
		expect(fake.holds).toEqual({ taken: 1, released: 1 })
	})

	it("is cancelled by its signal, by a newer request and by signing out", async () => {
		const fake = fakeRuntime()
		const transformer = createAssistantTransformer(fake.runtime)
		const controller = new AbortController()
		const first = transformer.run(request({ signal: controller.signal }))

		await settle()
		controller.abort()
		await expect(first).resolves.toEqual({ ok: false, error: "cancelled" })

		const second = transformer.run(request())

		await settle()

		const third = transformer.run(request())

		await expect(second).resolves.toEqual({ ok: false, error: "cancelled" })
		await settle()
		transformer.shutdown()
		await expect(third).resolves.toEqual({ ok: false, error: "cancelled" })
		await expect(transformer.run(request())).resolves.toEqual({ ok: false, error: "cancelled" })
		expect(fake.holds.taken).toBe(fake.holds.released)
	})
})
