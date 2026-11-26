// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import "@/lib/i18n"

// Each video player's repeat: kept on this device in the kv store, read at boot; the preview's player loops unless
// turned off, the Videos player moves on unless turned on.

const { stored, kvSetJson } = vi.hoisted(() => ({
	stored: new Map<string, unknown>(),
	kvSetJson: vi.fn((key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	})
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson,
	kvDelete: () => Promise.resolve()
}))

async function freshModules() {
	vi.resetModules()

	const repeat = await import("@/lib/media/videoRepeat")
	const { RepeatButton } = await import("@/features/preview/components/repeatButton")
	const { RepeatButton: VideosRepeatButton } = await import("@/features/videos/components/player/repeatButton")
	const { handlePlayerKeyDown } = await import("@/lib/media/playerKeyboard")

	return { ...repeat, RepeatButton, VideosRepeatButton, handlePlayerKeyDown }
}

afterEach(() => {
	cleanup()
	stored.clear()
})

describe("video repeat", () => {
	it("is on in the preview and off in Videos by default", async () => {
		const { loadVideoRepeat, videoRepeat } = await freshModules()

		await loadVideoRepeat()

		expect(videoRepeat("preview")).toBe(true)
		expect(videoRepeat("videos")).toBe(false)
	})

	it("is read from the kv store at boot, per player", async () => {
		stored.set("media.repeat.preview.v1", false)
		stored.set("media.repeat.videos.v1", true)

		const { loadVideoRepeat, useVideoRepeat } = await freshModules()
		const preview = renderHook(() => useVideoRepeat("preview"))

		expect(preview.result.current).toBe(true)

		await act(() => loadVideoRepeat())

		expect(preview.result.current).toBe(false)
		expect(renderHook(() => useVideoRepeat("videos")).result.current).toBe(true)
	})

	it("keeps a toggle in the kv store, leaving the other player's alone", async () => {
		const { toggleVideoRepeat, videoRepeat } = await freshModules()

		toggleVideoRepeat("videos")

		expect(videoRepeat("videos")).toBe(true)
		expect(videoRepeat("preview")).toBe(true)
		expect(kvSetJson).toHaveBeenCalledWith("media.repeat.videos.v1", true)
		expect(kvSetJson).not.toHaveBeenCalledWith("media.repeat.preview.v1", expect.anything())
	})

	it("is a pressed toggle in the preview's bar that turns it off and on", async () => {
		const { RepeatButton, videoRepeat } = await freshModules()

		render(<RepeatButton />)

		const button = screen.getByRole("button", { name: "Repeat" })

		expect(button.getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(button)

		expect(button.getAttribute("aria-pressed")).toBe("false")
		expect(videoRepeat("preview")).toBe(false)
		expect(kvSetJson).toHaveBeenCalledWith("media.repeat.preview.v1", false)

		fireEvent.click(button)

		expect(button.getAttribute("aria-pressed")).toBe("true")
	})

	it("is an unpressed toggle in the Videos player's bar that turns it on", async () => {
		const { VideosRepeatButton, videoRepeat } = await freshModules()

		render(<VideosRepeatButton />)

		const button = screen.getByRole("button", { name: "Repeat" })

		expect(button.getAttribute("aria-pressed")).toBe("false")

		fireEvent.click(button)

		expect(button.getAttribute("aria-pressed")).toBe("true")
		expect(videoRepeat("videos")).toBe(true)
		expect(videoRepeat("preview")).toBe(true)
		expect(kvSetJson).toHaveBeenCalledWith("media.repeat.videos.v1", true)
	})

	it("turns off and on with R in the preview's player", async () => {
		const { handlePlayerKeyDown, videoRepeat } = await freshModules()
		const video = document.createElement("video")
		const seeks = { target: () => 0, seekBy: () => undefined, cancel: () => undefined }
		const press = () =>
			handlePlayerKeyDown(
				{
					code: "KeyR",
					key: "r",
					ctrlKey: false,
					metaKey: false,
					shiftKey: false,
					altKey: false,
					repeat: false,
					defaultPrevented: false,
					target: video,
					preventDefault: () => undefined,
					stopPropagation: () => undefined
				},
				video,
				null,
				{},
				[],
				seeks
			)

		expect(press()).toBe(true)
		expect(videoRepeat("preview")).toBe(false)
		expect(press()).toBe(true)
		expect(videoRepeat("preview")).toBe(true)
		expect(videoRepeat("videos")).toBe(false)
	})
})
