// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { Transition } from "@filen/office/core/anim"
import { slideRef } from "@filen/office/core/presentation"
import type { PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import { useSlideTransition } from "@/features/presentation/components/ribbon/transitions"

// The Transitions tab's slide state is per session: two decks whose slides share a ref and a revision never see each
// other's transition.

afterEach(() => {
	cleanup()
})

const ref = slideRef(1)
const render = { ref, revision: 0 } as unknown as SlideRender

function transition(kind: string): Transition {
	return { kind, namespace: "p", options: {}, advance: { onClick: true } } as unknown as Transition
}

function sessionOf(kind: string) {
	let answer: (() => void) | undefined
	const timegraph = vi.fn(
		() =>
			new Promise<{ source: { transition: Transition } }>(resolve => {
				answer = () => {
					resolve({ source: { transition: transition(kind) } })
				}
			})
	)

	return {
		session: { timegraph } as unknown as PresentationSessionApi,
		timegraph,
		answer: async (): Promise<void> => {
			await act(async () => {
				answer?.()
				await Promise.resolve()
			})
		}
	}
}

describe("useSlideTransition", () => {
	it("asks a second deck for its own slide, idle until it answers", async () => {
		const first = sessionOf("push")
		const second = sessionOf("fade")
		const seen: { readonly session: PresentationSessionApi; readonly kind: string | undefined; readonly loaded: boolean }[] = []
		const { result, rerender } = renderHook(
			({ session }) => {
				const state = useSlideTransition({ render, session })

				seen.push({ session, kind: state.transition?.kind, loaded: state.loaded })

				return state
			},
			{ initialProps: { session: first.session } }
		)

		expect(first.timegraph).toHaveBeenCalledTimes(1)
		await first.answer()
		expect(result.current.loaded).toBe(true)
		expect(result.current.transition?.kind).toBe("push")

		rerender({ session: second.session })

		// Every render of the other deck, the first one included, holds nothing of the first deck's answer.
		expect(seen.filter(entry => entry.session === second.session)).toEqual(
			expect.arrayContaining([{ session: second.session, kind: undefined, loaded: false }])
		)
		expect(seen.filter(entry => entry.session === second.session && entry.kind === "push")).toEqual([])
		expect(second.timegraph).toHaveBeenCalledTimes(1)
		expect(second.timegraph).toHaveBeenCalledWith(ref)

		await second.answer()
		expect(result.current.loaded).toBe(true)
		expect(result.current.transition?.kind).toBe("fade")
	})
})
