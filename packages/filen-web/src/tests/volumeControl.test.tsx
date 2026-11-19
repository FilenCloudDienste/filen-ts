// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve()
}))

const { VolumeControl } = await import("@/components/media/volumeControl")
const { useMediaVolumeStore } = await import("@/lib/media/mediaVolume")

afterEach(() => {
	cleanup()
	useMediaVolumeStore.setState({ volume: 1, muted: false })
})

// The mute button encodes its state once, in the label: a pressed state on top would read "Unmute, pressed".
describe("VolumeControl mute button", () => {
	it("is named Mute without a pressed state while sound plays", () => {
		render(<VolumeControl />)

		const button = screen.getByRole("button", { name: "Mute" })

		expect(button.hasAttribute("aria-pressed")).toBe(false)
	})

	it("is named Unmute without a pressed state while muted", () => {
		render(<VolumeControl />)

		act(() => {
			useMediaVolumeStore.setState({ volume: 1, muted: true })
		})

		const button = screen.getByRole("button", { name: "Unmute" })

		expect(button.hasAttribute("aria-pressed")).toBe(false)
	})
})
