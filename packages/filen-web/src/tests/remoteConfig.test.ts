// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryObserver, focusManager } from "@tanstack/react-query"
import { createTestQueryClient } from "@/tests/testQueryClient"
import type { Announcement, RemoteConfig } from "@/features/settings/lib/remoteConfig"

const { kvStore, kvSetJson } = vi.hoisted(() => {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", async () => {
	const { type } = await import("arktype")

	return {
		kvGetJson: (key: string, schema: (value: unknown) => unknown) => {
			const parsed = kvStore.has(key) ? schema(kvStore.get(key)) : null

			return Promise.resolve(parsed instanceof type.errors ? null : parsed)
		},
		kvSetJson
	}
})

vi.mock("@/queries/persist", () => ({
	noDiskPersister: <T>(queryFn: (context: unknown) => T, context: unknown) => queryFn(context)
}))

const {
	DISMISSED_ANNOUNCEMENTS_QUERY_KEY,
	REMOTE_CONFIG_QUERY_KEY,
	currentAnnouncement,
	dismissAnnouncement,
	parseRemoteConfig,
	platformAnnouncements,
	remoteConfigQueryOptions,
	remoteConfigRefetchInterval,
	remoteConfigStaleTime
} = await import("@/features/settings/lib/remoteConfig")
const { noDiskPersister } = await import("@/queries/persist")

function announcement(overrides: Partial<Announcement>): Announcement {
	return {
		uuid: "a",
		title: "Title",
		message: "Message",
		active: true,
		timestamp: 1,
		platforms: ["all"],
		...overrides
	}
}

const VALID_PLAN = {
	termType: 2,
	id: 27,
	name: "Pro I",
	cost: 1.99,
	sale: 0.99,
	storage: 214748364800,
	popular: false,
	term: "monthly"
}

const VALID_CFG = {
	maintenance: false,
	readOnly: false,
	announcements: [
		{
			uuid: "89159575-1be0-4971-a29b-8d2f2bb25c86",
			title: "Maintenance",
			message: "Filen will be unavailable.",
			active: false,
			timestamp: 1675336972215,
			platforms: ["web", "mobile", "desktop", "all"]
		}
	],
	pricing: { lifetimeEnabled: false, saleEnabled: false, plans: [VALID_PLAN] }
}

describe("parseRemoteConfig", () => {
	it("parses the live shape", () => {
		expect(parseRemoteConfig(VALID_CFG)).toEqual(VALID_CFG)
	})

	it("ignores and strips unknown keys at every level", () => {
		const parsed = parseRemoteConfig({
			...VALID_CFG,
			future: { x: 1 },
			announcements: [{ ...VALID_CFG.announcements[0], severity: "high" }],
			pricing: { ...VALID_CFG.pricing, currency: "EUR", plans: [{ ...VALID_PLAN, badge: "new" }] }
		})

		expect(parsed).toEqual(VALID_CFG)
	})

	it("drops bad announcements and plans one by one", () => {
		const parsed = parseRemoteConfig({
			...VALID_CFG,
			announcements: [VALID_CFG.announcements[0], { uuid: "x", title: 1 }, null, "text"],
			pricing: { ...VALID_CFG.pricing, plans: [VALID_PLAN, { ...VALID_PLAN, term: "weekly" }, { ...VALID_PLAN, id: "27" }] }
		})

		expect(parsed?.announcements).toEqual(VALID_CFG.announcements)
		expect(parsed?.pricing?.plans).toEqual([VALID_PLAN])
	})

	it("keeps maintenance and announcements when pricing is malformed", () => {
		const parsed = parseRemoteConfig({ ...VALID_CFG, maintenance: true, pricing: { plans: "none" } })

		expect(parsed).toEqual({ ...VALID_CFG, maintenance: true, pricing: null })
	})

	it("defaults missing or non-boolean flags to false and missing lists to empty", () => {
		expect(parseRemoteConfig({ maintenance: "yes" })).toEqual({ maintenance: false, readOnly: false, announcements: [], pricing: null })
	})

	it("rejects a body that is not an object", () => {
		expect(parseRemoteConfig(null)).toBeNull()
		expect(parseRemoteConfig([VALID_CFG])).toBeNull()
		expect(parseRemoteConfig("cfg")).toBeNull()
	})
})

describe("announcement selection", () => {
	it("keeps active ones for the platform or all, newest first", () => {
		const list = [
			announcement({ uuid: "old-web", timestamp: 1, platforms: ["web"] }),
			announcement({ uuid: "desktop", timestamp: 5, platforms: ["desktop"] }),
			announcement({ uuid: "mobile", timestamp: 6, platforms: ["mobile"] }),
			announcement({ uuid: "inactive", timestamp: 7, active: false }),
			announcement({ uuid: "new-all", timestamp: 3, platforms: ["all"] })
		]

		expect(platformAnnouncements(list, "web").map(item => item.uuid)).toEqual(["new-all", "old-web"])
		expect(platformAnnouncements(list, "desktop").map(item => item.uuid)).toEqual(["desktop", "new-all"])
	})

	it("shows the newest not dismissed", () => {
		const candidates = [announcement({ uuid: "b", timestamp: 2 }), announcement({ uuid: "a", timestamp: 1 })]

		expect(currentAnnouncement(candidates, [])?.uuid).toBe("b")
		expect(currentAnnouncement(candidates, ["b"])?.uuid).toBe("a")
		expect(currentAnnouncement(candidates, ["a", "b"])).toBeUndefined()
	})
})

describe("dismissAnnouncement", () => {
	beforeEach(() => {
		kvStore.clear()
	})

	it("hides at once, persists, and prunes ids the config no longer lists", async () => {
		const client = createTestQueryClient()
		const listed = [announcement({ uuid: "kept" }), announcement({ uuid: "new" })]

		client.setQueryData(DISMISSED_ANNOUNCEMENTS_QUERY_KEY, ["kept", "retired"])

		const pending = dismissAnnouncement(client, "new", listed)

		expect(client.getQueryData(DISMISSED_ANNOUNCEMENTS_QUERY_KEY)).toEqual(["kept", "new"])

		await pending

		expect(kvStore.get("remoteConfig.dismissedAnnouncements.v1")).toEqual(["kept", "new"])
	})

	it("keeps the dismissal in memory when the write fails", async () => {
		const client = createTestQueryClient()

		kvSetJson.mockRejectedValueOnce(new Error("disk"))

		await dismissAnnouncement(client, "a", [announcement({ uuid: "a" })])

		expect(client.getQueryData(DISMISSED_ANNOUNCEMENTS_QUERY_KEY)).toEqual(["a"])
	})
})

function respondWith(body: unknown) {
	return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
}

describe("remote config query", () => {
	afterEach(() => {
		focusManager.setFocused(undefined)
		vi.useRealTimers()
	})

	it("is never persisted to disk", () => {
		expect(remoteConfigQueryOptions().persister).toBe(noDiskPersister)
	})

	it("fetches without credentials and revalidates the HTTP cache", async () => {
		const fetchMock = respondWith(VALID_CFG)

		vi.stubGlobal("fetch", fetchMock)

		const client = createTestQueryClient()

		await client.query(remoteConfigQueryOptions())

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringMatching(/^https:\/\/cdn\.filen\.io\/cfg(\.test)?\.json$/),
			expect.objectContaining({ credentials: "omit", cache: "no-cache" })
		)
	})

	it("keeps this session's last config when a fetch fails, and is null with nothing fetched yet", async () => {
		const client = createTestQueryClient()

		vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")))

		expect(await client.query(remoteConfigQueryOptions())).toBeNull()

		vi.stubGlobal("fetch", respondWith({ ...VALID_CFG, maintenance: true }))
		await client.refetchQueries({ queryKey: REMOTE_CONFIG_QUERY_KEY })

		vi.stubGlobal("fetch", () => Promise.resolve(new Response("oops", { status: 503 })))
		await client.refetchQueries({ queryKey: REMOTE_CONFIG_QUERY_KEY })

		expect(client.getQueryData<RemoteConfig | null>(REMOTE_CONFIG_QUERY_KEY)?.maintenance).toBe(true)
	})

	it("polls faster and never treats data as fresh while maintenance is on", () => {
		const normal = { state: { data: parseRemoteConfig(VALID_CFG) } }
		const maintenance = { state: { data: parseRemoteConfig({ ...VALID_CFG, maintenance: true }) } }

		expect(remoteConfigRefetchInterval(normal)).toBe(600_000)
		expect(remoteConfigStaleTime(normal)).toBe(300_000)
		expect(remoteConfigRefetchInterval(maintenance)).toBe(30_000)
		expect(remoteConfigStaleTime(maintenance)).toBe(0)
		expect(remoteConfigRefetchInterval({ state: { data: undefined } })).toBe(600_000)
	})

	it("refetches every 10 minutes only while the document is visible", async () => {
		vi.useFakeTimers()
		focusManager.setFocused(true)

		const fetchMock = respondWith(VALID_CFG)

		vi.stubGlobal("fetch", fetchMock)

		const client = createTestQueryClient()

		// Subscribes the cache to focus changes, as the provider does in the app.
		client.mount()

		const observer = new QueryObserver(client, remoteConfigQueryOptions())
		const unsubscribe = observer.subscribe(() => undefined)

		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(60 * 1000)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		focusManager.setFocused(false)
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// Back to the tab with stale data: one refetch through refetchOnWindowFocus.
		focusManager.setFocused(true)
		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		unsubscribe()
		client.unmount()
	})
})
