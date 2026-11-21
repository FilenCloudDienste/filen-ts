// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

vi.mock("sonner", () => ({ toast: vi.fn() }))

import { registerAssistantTransformer } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { TransformSelection } from "@/features/assistant/transform/host"
import { TransformPopover } from "@/features/assistant/transform/transformPopover"
import {
	diffSegments,
	recentTransformLanguages,
	transformOffered,
	uiTransformLanguage,
	withRecentLanguage
} from "@/features/assistant/transform/transform.logic"
import type { AssistantModelState, AssistantTransformOutcome, AssistantTransformRequest } from "@/features/assistant/types"

const MODEL = { id: "m", name: "Model", sizeBytes: 2_600_000_000 }

let pending: { request: AssistantTransformRequest; resolve: (outcome: AssistantTransformOutcome) => void } | null = null
let unregister: () => void

function selection(text: string): { selection: TransformSelection; replace: ReturnType<typeof vi.fn>; edited: () => void } {
	let current = true
	const replace = vi.fn(() => ({ undo: null }))

	return {
		selection: { text, current: () => current, replace, rect: () => null },
		replace,
		edited: () => {
			current = false
		}
	}
}

function modelState(state: AssistantModelState): void {
	act(() => {
		useAssistantStore.setState({ modelState: state })
	})
}

async function finish(outcome: AssistantTransformOutcome): Promise<void> {
	await act(async () => {
		pending?.resolve(outcome)
		await Promise.resolve()
	})
}

beforeEach(() => {
	pending = null
	unregister = registerAssistantTransformer({
		run: request =>
			new Promise(resolve => {
				pending = { request, resolve }
			}),
		shutdown: () => undefined
	})
	useAssistantStore.setState({ modelState: { kind: "ready", model: MODEL } })
})

afterEach(() => {
	unregister()
	cleanup()
})

function show(text: string, onClose = vi.fn()) {
	const taken = selection(text)

	render(
		<TransformPopover
			request={{ selection: taken.selection, kind: "rewrite", language: "en" }}
			anchor={() => null}
			onClose={onClose}
		/>
	)

	return { taken, onClose }
}

describe("TransformPopover", () => {
	it("streams the result, then applies the raw text on Accept and closes", async () => {
		const { taken, onClose } = show("helo wrld")

		expect(screen.getByRole("button", { name: /Accept/ })).toHaveProperty("disabled", true)
		act(() => {
			pending?.request.onText("Hello")
		})
		expect(screen.getByText("Hello")).toBeTruthy()
		await finish({ ok: true, text: "Hello &amp; a\\.b", truncated: false, foreignLinks: [] })

		const accept = screen.getByRole("button", { name: /Accept/ })

		expect(accept).toHaveProperty("disabled", false)
		fireEvent.click(accept)
		expect(taken.replace).toHaveBeenCalledWith("Hello &amp; a\\.b")
		expect(onClose).toHaveBeenCalledWith(true)
	})

	it("keeps Accept off for a result with a link the selection did not hold, and offers Try again", async () => {
		const { taken } = show("call me")

		await finish({ ok: true, text: "call me at evil.example", truncated: false, foreignLinks: ["evil.example"] })
		expect(screen.getByRole("alert").textContent).toContain("evil.example")
		expect(screen.getByRole("button", { name: /Accept/ })).toHaveProperty("disabled", true)
		fireEvent.click(screen.getByRole("button", { name: "Try again" }))
		expect(pending?.request.text).toBe("call me")
		expect(taken.replace).not.toHaveBeenCalled()
	})

	it("states an edit of the text meanwhile and keeps Accept off", async () => {
		const { taken } = show("one two")

		await finish({ ok: true, text: "One, two.", truncated: false, foreignLinks: [] })
		taken.edited()
		fireEvent.input(document.body)
		await act(async () => {
			await new Promise(resolve => requestAnimationFrame(resolve))
		})
		expect(screen.getByRole("alert").textContent).toContain("changed")
		expect(screen.getByRole("button", { name: /Accept/ })).toHaveProperty("disabled", true)
	})

	it("explains a model not downloaded with its size, and runs nothing until it is", () => {
		modelState({ kind: "not-downloaded", model: MODEL })
		show("text")

		expect(screen.getByRole("button", { name: "Download (2.42 GiB)" })).toBeTruthy()
		expect(pending).toBeNull()
		modelState({ kind: "downloaded", model: MODEL, idleUnloaded: false })
		expect(pending?.request.text).toBe("text")
	})

	it("says another tab holds the model", () => {
		modelState({ kind: "unavailable", reason: "in-use-elsewhere", model: MODEL })
		show("text")

		expect(screen.getByText(/in use in another tab/)).toBeTruthy()
	})

	it("discards without applying", () => {
		const { taken, onClose } = show("text")

		fireEvent.click(screen.getByRole("button", { name: "Discard" }))
		expect(onClose).toHaveBeenCalledWith(false)
		expect(taken.replace).not.toHaveBeenCalled()
	})
})

describe("transform logic", () => {
	it("maps the UI language to a target and keeps recent targets newest first", () => {
		expect(uiTransformLanguage("pt-BR")).toBe("pt")
		expect(uiTransformLanguage("zh-TW")).toBe("zh")
		expect(uiTransformLanguage("pl")).toBe("en")
		expect(recentTransformLanguages([], "de")).toEqual(["de"])
		expect(withRecentLanguage(["fr", "de", "ja"], "de")).toEqual(["de", "fr", "ja"])
		expect(withRecentLanguage(["fr", "de", "ja"], "ar")).toEqual(["ar", "fr", "de"])
	})

	it("offers the transform unless the device can never run the model or the check has not answered", () => {
		expect(transformOffered({ kind: "checking", model: null })).toBe(false)
		expect(transformOffered({ kind: "unavailable", reason: "unsupported-browser", model: null })).toBe(false)
		expect(transformOffered({ kind: "unavailable", reason: "in-use-elsewhere", model: null })).toBe(true)
		expect(transformOffered({ kind: "not-downloaded", model: MODEL })).toBe(true)
	})

	it("diffs the result against the selection into runs that rebuild both", () => {
		const segments = diffSegments("the quick fox", "the slow fox")

		expect(
			segments
				.filter(segment => segment.kind !== "added")
				.map(segment => segment.text)
				.join("")
		).toBe("the quick fox")
		expect(
			segments
				.filter(segment => segment.kind !== "removed")
				.map(segment => segment.text)
				.join("")
		).toBe("the slow fox")
		expect(segments.some(segment => segment.kind === "removed" && segment.text.includes("quick"))).toBe(true)
	})
})
