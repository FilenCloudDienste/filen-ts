// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, act } from "@testing-library/react"
import { createElement } from "react"
import { onlineManager } from "@tanstack/react-query"
import "@/lib/i18n"
import { OfflineIndicator } from "@/features/shell/components/offlineIndicator"

beforeEach(() => {
	onlineManager.setOnline(true)
	vi.useFakeTimers()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("OfflineIndicator", () => {
	it("renders nothing while online", () => {
		render(createElement(OfflineIndicator))

		expect(screen.queryByRole("status")).toBeNull()
	})

	it("renders the offline pill when the connection drops", () => {
		render(createElement(OfflineIndicator))

		act(() => {
			onlineManager.setOnline(false)
		})

		expect(screen.getByRole("status").textContent).toContain("Offline")
	})

	it("shows a back-online confirmation on reconnect, then auto-dismisses", () => {
		onlineManager.setOnline(false)
		render(createElement(OfflineIndicator))

		expect(screen.getByRole("status").textContent).toContain("Offline")

		act(() => {
			onlineManager.setOnline(true)
		})

		expect(screen.getByRole("status").textContent).toContain("Back online")

		act(() => {
			vi.advanceTimersByTime(2000)
		})

		expect(screen.queryByRole("status")).toBeNull()
	})

	it("cancels the back-online decay if connectivity drops again first", () => {
		onlineManager.setOnline(false)
		render(createElement(OfflineIndicator))

		act(() => {
			onlineManager.setOnline(true)
		})

		expect(screen.getByRole("status").textContent).toContain("Back online")

		act(() => {
			onlineManager.setOnline(false)
		})

		expect(screen.getByRole("status").textContent).toContain("Offline")

		act(() => {
			vi.advanceTimersByTime(2000)
		})

		// Still offline — the stale back-online timer must not have forced it to "online"/hidden.
		expect(screen.getByRole("status").textContent).toContain("Offline")
	})
})
