// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { createElement, type ReactNode } from "react"

const mocks = vi.hoisted(() => ({
	linksQuery: vi.fn()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@filen/sdk-rs", () => ({}))
vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	parseFilenPublicLink: (url: string) => (url.includes("app.filen.io/") ? { type: "file", uuid: "f1", key: "key" } : null)
}))
vi.mock("@/components/ui/view", () => ({
	default: ({ children, className }: { children?: ReactNode; className?: string }) =>
		createElement("div", { "data-testid": className?.includes("gap-4") ? "attachments" : "attachment" }, children)
}))
vi.mock("@/features/chats/components/chat/message/regexed", () => ({
	default: () => createElement("span", { "data-testid": "regexed" })
}))
vi.mock("@/features/chats/components/chat/message/imageAttachment", () => ({ default: () => null }))
vi.mock("@/features/chats/components/chat/message/videoAttachment", () => ({ default: () => null }))
vi.mock("@/features/chats/components/chat/message/internalAttachment", () => ({
	default: () => createElement("span", { "data-testid": "internal" })
}))
vi.mock("@/features/chats/utils", () => ({
	resolveLinkMedia: () => ({ type: "internal", linked: {} })
}))
vi.mock("@/features/chats/queries/useChatMessageLinks.query", () => ({ default: mocks.linksQuery }))
vi.mock("@/stores/useHttp.store", () => ({ default: () => null }))
vi.mock("@shopify/flash-list", async () => {
	const { useState } = await import("react")

	return {
		useMappingHelper: () => ({ getMappingKey: (key: string) => key }),
		useRecyclingState: (initial: unknown) => useState(initial)
	}
})

import Attachments from "@/features/chats/components/chat/message/attachments"

const FILEN_LINK = "https://app.filen.io/#/d/f1"
const EXTERNAL_LINK = "https://example.com/page"
const SUCCESSFUL = { type: "internal", success: true, data: { type: "file", file: { uuid: "f1" } } }

function renderAttachments(text: string, single: boolean) {
	return render(
		createElement(Attachments, {
			chat: {} as never,
			message: { inner: { uuid: "m1", message: text } } as never,
			fromSelf: false,
			single,
			maxWidth: 200
		})
	)
}

beforeEach(() => {
	mocks.linksQuery.mockReset()
	mocks.linksQuery.mockReturnValue({ data: undefined })
})

afterEach(() => {
	cleanup()
})

describe("Attachments", () => {
	it("does not query a message whose links are all external", () => {
		renderAttachments(`see ${EXTERNAL_LINK}`, false)

		expect(mocks.linksQuery).toHaveBeenCalledWith({ urls: [] }, { enabled: false })
	})

	it("queries only the Filen links of a mixed message", () => {
		renderAttachments(`${EXTERNAL_LINK} and ${FILEN_LINK}`, false)

		const [params, options] = mocks.linksQuery.mock.calls[0] ?? []

		expect(params).toEqual({ urls: [FILEN_LINK] })
		expect(options).toEqual({ enabled: true })
	})

	it("keys the query by URL alone, so the same link at different offsets shares an entry", () => {
		renderAttachments(`see ${FILEN_LINK}`, false)

		const [first] = mocks.linksQuery.mock.calls.at(-1) ?? []

		cleanup()

		renderAttachments(`a much longer preamble before ${FILEN_LINK}`, false)

		const [second] = mocks.linksQuery.mock.calls.at(-1) ?? []

		expect(first).toEqual({ urls: [FILEN_LINK] })
		expect(second).toEqual(first)
	})

	it("renders no spacer when every resolved link failed", () => {
		mocks.linksQuery.mockReturnValue({ data: [{ type: "internal", success: false }] })

		const { queryByTestId } = renderAttachments(`see ${FILEN_LINK}`, false)

		expect(queryByTestId("attachments")).toBeNull()
	})

	it("renders only the successful previews, without empty slots for failures", () => {
		mocks.linksQuery.mockReturnValue({ data: [{ type: "internal", success: false }, SUCCESSFUL] })

		const { getByTestId, getAllByTestId } = renderAttachments(`see ${FILEN_LINK} ${FILEN_LINK}`, false)

		expect(getByTestId("attachments").children).toHaveLength(1)
		expect(getAllByTestId("internal")).toHaveLength(1)
	})

	it("falls back to the text for a link-only message with an external link", () => {
		const { getByTestId } = renderAttachments(EXTERNAL_LINK, true)

		expect(getByTestId("regexed")).toBeTruthy()
		expect(mocks.linksQuery).toHaveBeenCalledWith({ urls: [] }, { enabled: false })
	})
})
