// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
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

// Dragging sets any level; the arrow keys keep the players' 5% step.
describe("VolumeControl slider", () => {
	it("takes a level between the keyboard's steps", () => {
		render(<VolumeControl />)

		fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.37" } })

		expect(useMediaVolumeStore.getState().volume).toBeCloseTo(0.37)
	})

	it("steps by 5% on the arrow keys", () => {
		useMediaVolumeStore.setState({ volume: 0.5, muted: false })
		render(<VolumeControl />)

		const slider = screen.getByRole("slider", { name: "Volume" })

		fireEvent.keyDown(slider, { key: "ArrowUp" })
		expect(useMediaVolumeStore.getState().volume).toBeCloseTo(0.55)
		fireEvent.keyDown(slider, { key: "ArrowLeft" })
		fireEvent.keyDown(slider, { key: "ArrowLeft" })
		expect(useMediaVolumeStore.getState().volume).toBeCloseTo(0.45)
	})
})
