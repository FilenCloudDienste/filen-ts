// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { ChatConnectionBanner } = await import("@/features/chats/components/chatConnectionBanner")
const { useSocketStatusStore } = await import("@/features/chats/store/useSocketStatus")

afterEach(() => {
	cleanup()
	useSocketStatusStore.setState({ status: "connected" })
})

describe("ChatConnectionBanner", () => {
	it("keeps its live region mounted and only toggles the content", () => {
		render(<ChatConnectionBanner />)

		const region = screen.getByRole("status")

		expect(region.textContent).toBe("")
		expect(region.className).not.toContain("bg-warning")

		act(() => {
			useSocketStatusStore.getState().setStatus("reconnecting")
		})

		expect(screen.getByRole("status")).toBe(region)
		expect(region.textContent).toBe("chatReconnecting")
		expect(region.className).toContain("bg-warning")

		act(() => {
			useSocketStatusStore.getState().setStatus("connected")
		})

		expect(screen.getByRole("status")).toBe(region)
		expect(region.isConnected).toBe(true)
		expect(region.textContent).toBe("")
		expect(region.className).not.toContain("bg-warning")
	})
})
