// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import type { AnyRouter } from "@tanstack/react-router"
import { refreshDocumentTitle, titleOf } from "@/lib/head/refreshTitle"

function fakeRouter(matches: { routeId: string; _notFound?: boolean }[], heads: Record<string, () => unknown>): AnyRouter {
	return {
		options: {},
		state: { matches: matches.map(match => ({ ...match, params: {}, loaderData: undefined })) },
		routesById: Object.fromEntries(Object.entries(heads).map(([id, head]) => [id, { options: { head } }]))
	} as unknown as AnyRouter
}

describe("refreshDocumentTitle", () => {
	it("sets the deepest match's title from fresh head results", async () => {
		const deep = vi.fn(() => ({ meta: [{ title: "Einstellungen · Filen" }] }))

		await refreshDocumentTitle(
			fakeRouter([{ routeId: "__root__" }, { routeId: "/_app" }, { routeId: "/_app/settings" }], {
				__root__: () => ({ meta: [{ title: "Filen" }] }),
				"/_app/settings": deep
			})
		)

		expect(deep).toHaveBeenCalledOnce()
		expect(document.title).toBe("Einstellungen · Filen")
	})

	it("stops at the not-found boundary", async () => {
		await refreshDocumentTitle(
			fakeRouter([{ routeId: "__root__", _notFound: true }, { routeId: "/_app" }], {
				__root__: () => ({ meta: [{ title: "Nicht gefunden · Filen" }] }),
				"/_app": () => ({ meta: [{ title: "App" }] })
			})
		)

		expect(document.title).toBe("Nicht gefunden · Filen")
	})

	it("reads only a title tag", () => {
		expect(titleOf({ meta: [{ name: "robots", content: "noindex" }, { title: "T" }] })).toBe("T")
		expect(titleOf({ meta: [{ name: "robots", content: "noindex" }] })).toBeUndefined()
		expect(titleOf(undefined)).toBeUndefined()
	})
})
