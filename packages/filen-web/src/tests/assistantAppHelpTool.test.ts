// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { RegisteredRouter } from "@tanstack/react-router"
import { assistantToolByName, parseToolInput, type AssistantToolFailure } from "@filen/shared/assistant"

const desktop = vi.hoisted(() => ({ app: false }))

vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => desktop.app, desktopBridge: () => undefined }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
// The setup's silent logger, with the ring size the Logs row names.
vi.mock("@/lib/log", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/log")>()),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), dump: () => [] }
}))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))

const { queryClient } = await import("@/queries/client")
const { ACCOUNT_QUERY_KEY } = await import("@/queries/account")
const { setAssistantRouter } = await import("@/features/assistant/tools/navigation")
const { createAssistantToolExecutor } = await import("@/features/assistant/tools/executor")
const { takeSettingsHighlight } = await import("@/lib/settingsHighlight")

type Executor = ReturnType<typeof createAssistantToolExecutor>
type Outcome = Awaited<ReturnType<Executor["execute"]>> | AssistantToolFailure

// Lands where it was sent, as the app's router does unless a dialog blocks it.
const router = {
	state: { location: { pathname: "/drive" } },
	subscribe: vi.fn(() => () => undefined),
	navigate: vi.fn((options: { to: string }) => {
		router.state.location.pathname = options.to

		return Promise.resolve()
	})
}

let executor: Executor

async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
	const tool = assistantToolByName(name)

	if (tool === undefined || !parseToolInput(tool, args).ok) {
		throw new Error(`bad test call ${name}`)
	}

	const checked = await executor.check({ callId: "call", tool, args })

	if (!checked.ok) {
		return checked
	}

	return executor.execute({ callId: "call", tool, args: checked.args, confirmed: false, signal: new AbortController().signal })
}

interface HelpResult {
	handle: string
	title: string
	description?: string
	where: string
	route: string
}

async function help(query: string): Promise<HelpResult[]> {
	const outcome = await call("app_help", { query })

	if (!outcome.ok) {
		throw new Error(outcome.error)
	}

	return (outcome.result as { results: HelpResult[] }).results
}

beforeEach(() => {
	router.state.location.pathname = "/drive"
	router.navigate.mockClear()
	setAssistantRouter(router as unknown as RegisteredRouter)
	queryClient.clear()
	executor = createAssistantToolExecutor()
	takeSettingsHighlight()
})

describe("app_help", () => {
	it("finds a setting by the user's words, with where it is, its section and a handle", async () => {
		const [first] = await help("How do I turn on two-factor authentication?")

		expect(first).toEqual({
			handle: "h1",
			title: "Two-factor authentication",
			description: expect.any(String) as string,
			where: "Settings → Security",
			route: "settings_security"
		})
	})

	it("says so when nothing matches, without a request", async () => {
		const outcome = await call("app_help", { query: "xylophone quartz" })

		expect(outcome).toMatchObject({ ok: true, result: { results: [] } })
		expect((outcome as { result: { note?: string } }).result.note).toBeTypeOf("string")
	})

	it("hides the desktop app's settings on the web", async () => {
		expect((await help("launch at login start minimized tray")).map(result => result.route)).not.toContain("settings_desktop")
	})

	it("fills a description's figures from what the app holds, and leaves it out when it holds none", async () => {
		const logs = (await help("diagnostic logs")).find(result => result.title === "Diagnostic logs")

		expect(logs?.description).toContain("500")

		const unheld = (await help("delete all files and directories")).find(result => result.route === "settings_account")

		expect(unheld?.description).toBeUndefined()

		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 2048n, versionedFiles: 0n, versionedStorage: 0n })

		const held = (await help("delete all files and directories")).find(result => result.route === "settings_account")

		expect(held?.description).toContain("2 KiB")
		expect(held?.description).not.toContain("{{")
	})
})

describe("open_route with an app_help handle", () => {
	it("opens the setting's section and asks Settings to ring it once there", async () => {
		const [first] = await help("two-factor authentication")

		// The handle names the section; a different route in the same call does not win.
		const outcome = await call("open_route", { route: "settings", help: first?.handle })

		expect(outcome).toMatchObject({ ok: true, result: { opened: "settings_security" } })
		expect(router.navigate).toHaveBeenCalledWith({ to: "/settings/security" })
		expect(takeSettingsHighlight()).toBe("twoFactor")
	})

	it("refuses a handle that names no app_help result", async () => {
		const outcome = await call("open_route", { route: "settings", help: "h9" })

		expect(outcome.ok).toBe(false)
		expect(takeSettingsHighlight()).toBeNull()
	})
})
