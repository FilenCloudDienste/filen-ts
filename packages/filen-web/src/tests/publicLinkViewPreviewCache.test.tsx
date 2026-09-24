// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { cleanup, render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/lib/i18n"

// The buffers a public link's preview (or a Download joining it) loaded live in the session preview
// cache, which only the public view itself can drop once the visitor leaves.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient: () => Promise.resolve(false) }, threadCount: () => 1 }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))
// A plain anchor stands in for the router's Link: the view renders outside a router here.
vi.mock("@tanstack/react-router", async () => {
	const { createElement: element, forwardRef } = await import("react")

	return {
		Link: forwardRef<HTMLAnchorElement, { to: string; children?: ReactNode }>(({ to, children }, ref) =>
			element("a", { ref, href: to }, children)
		)
	}
})

import { queryClient } from "@/queries/client"
import { PublicLinkView } from "@/features/publicLinks/components/publicLinkView"
import { clearPreviewCache, getPreviewBytes, loadPreviewBytes } from "@/features/preview/lib/previewCache"

const SCOPE = "anon:link-fingerprint"
const FILE = "aaaaaaaa-0000-0000-0000-000000000001"

// The link itself doesn't matter: with no key in the fragment the view renders its invalid state.
function renderView(uuid: string) {
	return render(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(PublicLinkView, {
				kind: "file",
				uuid
			})
		)
	)
}

async function cachePreviewBytes(): Promise<void> {
	await loadPreviewBytes(SCOPE, FILE, 3, () => Promise.resolve(new Uint8Array(3)))
}

beforeEach(() => {
	clearPreviewCache()
	queryClient.clear()
})

afterEach(() => {
	cleanup()
})

describe("PublicLinkView", () => {
	it("drops the preview buffers once the visitor leaves the link", async () => {
		const view = renderView("bbbbbbbb-0000-0000-0000-000000000002")

		await cachePreviewBytes()
		expect(getPreviewBytes(SCOPE, FILE)).toBeDefined()

		view.unmount()

		expect(getPreviewBytes(SCOPE, FILE)).toBeUndefined()
	})

	it("drops them when the same view moves on to another link", async () => {
		const view = renderView("bbbbbbbb-0000-0000-0000-000000000002")

		await cachePreviewBytes()
		view.rerender(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(PublicLinkView, {
					kind: "file",
					uuid: "cccccccc-0000-0000-0000-000000000003"
				})
			)
		)

		expect(getPreviewBytes(SCOPE, FILE)).toBeUndefined()
	})
})
