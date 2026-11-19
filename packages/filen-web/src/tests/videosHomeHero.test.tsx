// @vitest-environment jsdom

import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import "@/lib/i18n"
import type { HeroModel } from "@/features/videos/lib/homeRows.logic"
import { formatClockTime } from "@/lib/formatDate"

// The home hero's "Ends at" follows the clock while the home stays open, rather than the moment the home mounted.

const { probeGet } = vi.hoisted(() => ({ probeGet: vi.fn() }))

vi.mock("@/features/videos/lib/records", () => ({ probeRecords: { get: probeGet } }))
vi.mock("@/features/videos/hooks/useVideoArt", () => ({ useVideoArt: () => ({ kind: "none" }) }))
vi.mock("@/features/videos/components/videoCard", () => ({ ArtImage: () => null }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Link: ({ children, to: _to, params: _params, ...props }: { children: ReactNode; to: string; params?: unknown }) =>
		createElement("a", { ...props, href: "#" }, children)
}))

const { HomeHero } = await import("@/features/videos/components/homeHero")

const HERO = {
	title: { id: "movie", title: "A Movie", year: 2020, height: 1080, primary: { uuid: "file", stableUuid: "stable" } },
	card: null
} as unknown as HeroModel

afterEach(() => {
	vi.useRealTimers()
	probeGet.mockReset()
})

describe("HomeHero", () => {
	it("moves Ends at on with the clock while the home stays open", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		vi.setSystemTime(new Date(2026, 9, 9, 20, 0, 30))
		probeGet.mockResolvedValue({ probe: { durationSec: 7200, video: null, audio: [] } })

		const view = render(createElement(HomeHero, { hero: HERO, onShown: () => undefined }))

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0)
		})

		const endsAt = () => view.getByText(/^Ends at /).textContent

		expect(endsAt()).toBe(`Ends at ${formatClockTime(new Date(2026, 9, 9, 22, 0).getTime())}`)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000)
		})

		expect(endsAt()).toBe(`Ends at ${formatClockTime(new Date(2026, 9, 9, 22, 1).getTime())}`)
		view.unmount()
	})

	it("shows no Ends at while the duration is unknown", async () => {
		probeGet.mockResolvedValue(null)

		const view = render(createElement(HomeHero, { hero: HERO, onShown: () => undefined }))

		await act(async () => {
			await Promise.resolve()
		})

		expect(view.queryByText(/^Ends at /)).toBeNull()
		expect(view.getByText("2020 · 1080p")).toBeTruthy()
		view.unmount()
	})
})
