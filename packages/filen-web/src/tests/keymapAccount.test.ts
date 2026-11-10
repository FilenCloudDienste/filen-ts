import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"

// The keymap follows the account the app already holds, without ever fetching it.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

vi.mock("@/queries/account", () => ({ ACCOUNT_QUERY_KEY: ["account"] }))

const { followKeymapAccount } = await import("@/lib/keymap/account")
const { registerAction, comboFor, keymapOverridesLoaded } = await import("@/lib/keymap/registry")

describe("followKeymapAccount", () => {
	it("binds the account's record once the account is known, with no fetch of its own", async () => {
		const client = new QueryClient()
		const fetch = vi.fn()

		kvStore.set("keymap.v2.account.5", { overrides: { "app.test": "shift+x" }, characterKeys: true })
		registerAction({ id: "app.test", defaultCombo: "k", scope: "global", descriptionKey: "common:toggleTheme" })

		const stop = followKeymapAccount(client)

		client.getQueryCache().subscribe(event => {
			if (event.type === "observerResultsUpdated" && event.query.state.fetchStatus === "fetching") fetch()
		})
		await keymapOverridesLoaded()

		expect(comboFor("app.test")).toBe("k")

		client.setQueryData(["account"], { id: 5n, storageUsed: 1n })

		await vi.waitFor(async () => {
			await keymapOverridesLoaded()
			expect(comboFor("app.test")).toBe("shift+x")
		})
		expect(fetch).not.toHaveBeenCalled()

		stop()
	})
})
