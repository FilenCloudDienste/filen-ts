// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import "@/lib/i18n"

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => createElement("a", { href: to }, children)
}))

import { PublicLinkError, PublicLinkInvalid } from "@/features/publicLinks/components/publicLinkStates"

afterEach(cleanup)

describe("public link terminal surfaces", () => {
	it("keeps the dead-link copy for an invalid or expired link", () => {
		render(createElement(PublicLinkInvalid))

		expect(screen.getByText("This link is unavailable")).toBeTruthy()
		expect(screen.getByText("This link is invalid or has expired.")).toBeTruthy()
		expect(screen.getByRole("link", { name: "Back to Filen" })).toBeTruthy()
	})

	it("asks for the full link when the key was cut off", () => {
		render(createElement(PublicLinkInvalid, { reason: "incomplete" }))

		expect(screen.getByText("This link is incomplete")).toBeTruthy()
		expect(screen.getByText("Ask the sender for the full link.")).toBeTruthy()
		expect(screen.queryByText("This link is invalid or has expired.")).toBeNull()
	})

	it("tells a load failure apart from an expired link and retries", () => {
		const onRetry = vi.fn()

		render(createElement(PublicLinkError, { onRetry }))

		expect(screen.getByText("Couldn't load this link")).toBeTruthy()
		expect(screen.getByText("Check your connection and try again.")).toBeTruthy()
		expect(screen.queryByText("This link is invalid or has expired.")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(onRetry).toHaveBeenCalledTimes(1)
	})
})
