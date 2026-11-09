// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => undefined }))
vi.mock("@/lib/storage/adapter", async () => {
	const { type } = await import("arktype")

	return {
		kvGetJson: (key: string, schema: (value: unknown) => unknown) => {
			const parsed = kvStore.has(key) ? schema(kvStore.get(key)) : null

			return Promise.resolve(parsed instanceof type.errors ? null : parsed)
		},
		kvSetJson: (key: string, value: unknown) => {
			kvStore.set(key, value)

			return Promise.resolve()
		}
	}
})
vi.mock("@/queries/persist", () => ({
	noDiskPersister: <T,>(queryFn: (context: unknown) => T, context: unknown) => queryFn(context)
}))

const { AnnouncementStrip } = await import("@/features/shell/components/announcementStrip")

const DISMISSED_KEY = "remoteConfig.dismissedAnnouncements.v1"

function cfg(overrides: Record<string, unknown>) {
	return {
		maintenance: false,
		readOnly: false,
		announcements: [
			{
				uuid: "web-1",
				title: "Scheduled maintenance",
				message: "<b>Short</b> interruptions expected.",
				active: true,
				timestamp: 2,
				platforms: ["web"]
			},
			{ uuid: "desktop-1", title: "Desktop only", message: "Desktop text", active: true, timestamp: 3, platforms: ["desktop"] }
		],
		pricing: null,
		...overrides
	}
}

function serve(body: unknown): void {
	vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
}

async function renderStrip() {
	const client = createTestQueryClient()
	const view = render(<AnnouncementStrip />, { wrapper: queryClientWrapper(client) })

	// The config fetch, then the dismissed-list read it enables.
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})

	return view
}

beforeEach(() => {
	kvStore.clear()
})

afterEach(cleanup)

describe("AnnouncementStrip", () => {
	it("shows the newest active announcement for this platform as plain text", async () => {
		serve(cfg({}))
		await renderStrip()

		const strip = await screen.findByRole("status", { name: "announcementRegionLabel" })

		expect(strip.textContent).toContain("Scheduled maintenance")
		expect(strip.textContent).toContain("<b>Short</b> interruptions expected.")
		expect(strip.querySelector("b")).toBeNull()
		expect(screen.queryByText("Desktop only")).toBeNull()
	})

	it("hides a dismissed announcement and remembers it", async () => {
		serve(cfg({}))
		await renderStrip()

		const dismiss = await screen.findByRole("button", { name: "announcementDismiss" })

		act(() => {
			fireEvent.click(dismiss)
		})

		await waitFor(() => {
			expect(screen.queryByRole("status")).toBeNull()
		})
		expect(kvStore.get(DISMISSED_KEY)).toEqual(["web-1"])
	})

	it("never shows one dismissed earlier, not even while the dismissed list loads", async () => {
		const older = { uuid: "web-0", title: "Older notice", message: "Text", active: true, timestamp: 1, platforms: ["all"] }

		kvStore.set(DISMISSED_KEY, ["web-1"])
		serve(cfg({ announcements: [...cfg({}).announcements, older] }))

		const client = createTestQueryClient()
		const seen: string[] = []

		render(<AnnouncementStrip />, { wrapper: queryClientWrapper(client) })

		// Every committed state on the way, not only the settled one.
		const observer = new MutationObserver(() => {
			seen.push(document.body.textContent)
		})

		observer.observe(document.body, { childList: true, subtree: true, characterData: true })

		// The next one up shows once the dismissed list has loaded; the dismissed one never appeared before it.
		await screen.findByText("Older notice")
		observer.disconnect()

		expect(seen.some(text => text.includes("Scheduled maintenance"))).toBe(false)
	})

	it("shows maintenance as a warning with no dismiss button, over any announcement", async () => {
		serve(cfg({ maintenance: true }))
		await renderStrip()

		const strip = await screen.findByRole("status", { name: "maintenanceTitle" })

		expect(strip.textContent).toContain("maintenanceInfo")
		expect(screen.queryByText("Scheduled maintenance")).toBeNull()
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("renders nothing when the config cannot be read", async () => {
		vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")))

		const { container } = await renderStrip()

		expect(container.innerHTML).toBe("")
	})
})
