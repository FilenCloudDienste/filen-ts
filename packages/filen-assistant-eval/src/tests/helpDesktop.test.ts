import { describe, expect, it } from "vitest"
import { REMOTE_NOT_LOADED } from "@filen/shared"
import { APP_HELP, assistantToolByName } from "@filen/shared/assistant"
import { EVAL_CASES } from "../cases"
import { INJECTION_CASES } from "../cases/injection"
import { FakeApp } from "../fakeApp"
import { HELP_ROWS } from "../fixture"
import { LOOP_PRESETS, presetRunsCase } from "../loopHarness"

type HelpResult = { handle: string; title: string; where: string; route: string }

function help(app: FakeApp, query: string): HelpResult[] {
	const outcome = app.execute({ name: "app_help", args: { query } })

	if (!outcome.ok) {
		throw new Error(outcome.error)
	}

	return (outcome.result as { results: HelpResult[] }).results
}

describe("app_help in the fake app", () => {
	it("samples the shared registry, each row once", () => {
		const ids = new Set(APP_HELP.map(entry => entry.id))

		expect(HELP_ROWS.length).toBeGreaterThanOrEqual(30)
		expect(HELP_ROWS.filter(row => !ids.has(row.id)).map(row => row.id)).toEqual([])
		expect(new Set(HELP_ROWS.map(row => row.id)).size).toBe(HELP_ROWS.length)
	})

	it("finds a setting by the user's words and opens it highlighted by its handle", () => {
		const app = new FakeApp()
		const [first] = help(app, "turn on two-factor authentication")

		expect(first).toEqual({
			handle: "h1",
			title: "Two-factor authentication",
			description: expect.any(String) as string,
			where: "Settings → Security",
			route: "settings_security"
		})

		const opened = app.execute({ name: "open_route", args: { route: "settings", help: "h1" } })

		expect(opened.ok).toBe(true)
		expect(app.state.context.screen).toBe("settings_security")
		expect(app.state.opened).toBe("help:twoFactor")
	})

	it("refuses a help handle no result showed", () => {
		expect(new FakeApp().execute({ name: "open_route", args: { route: "settings", help: "h4" } })).toMatchObject({
			ok: false,
			invalid: true
		})
	})

	it("shows the desktop app's settings only there", () => {
		const query = "open at login keep running in the tray"

		expect(help(new FakeApp(), query).map(result => result.route)).not.toContain("settings_desktop")
		expect(help(new FakeApp({}, { desktop: true }), query).map(result => result.route)).toContain("settings_desktop")
	})
})

describe("get_desktop_status in the fake app", () => {
	it("reports the held sync pairs with s handles, an unread remote name as not loaded", () => {
		const app = new FakeApp({}, { desktop: true })
		const outcome = app.execute({ name: "get_desktop_status", args: { section: "sync" } })

		expect(outcome).toMatchObject({
			ok: true,
			result: {
				pairs: [
					{ handle: "s1", name: "Work", remote: "Work", progress: "12/40", issues: { conflicts: 2, failed: 1 } },
					{ handle: "s2", name: "Fotos", remote: REMOTE_NOT_LOADED },
					{ handle: "s3", name: "Music backup", paused: true }
				]
			}
		})
		expect(app.exposed.has("s1")).toBe(true)
	})

	it("reports the mounts, and opens a pair's issues by its handle", () => {
		const app = new FakeApp({}, { desktop: true })

		expect(app.execute({ name: "get_desktop_status", args: { section: "mounts" } })).toMatchObject({
			ok: true,
			result: { drive: { state: "running", at: "/Volumes/Filen" }, servers: [{ protocol: "webdav", error: "portInUse" }] }
		})

		app.execute({ name: "get_desktop_status", args: { section: "sync", query: "work" } })

		expect(app.execute({ name: "open_route", args: { route: "sync", pair: "s1" } })).toMatchObject({
			ok: true,
			result: { tab: "issues" }
		})
		expect(app.state.opened).toBe("pair:pair-work")
		expect(app.execute({ name: "open_route", args: { route: "sync", pair: "s9" } })).toMatchObject({ ok: false, invalid: true })
	})

	it("has no sync or mounts in the web app", () => {
		expect(new FakeApp().execute({ name: "get_desktop_status", args: { section: "sync" } })).toMatchObject({
			ok: false,
			invalid: false
		})
	})
})

describe("the desktop preset", () => {
	it("offers the desktop-only tools, which the web presets do not", () => {
		const status = assistantToolByName("get_desktop_status")

		if (status === undefined) {
			throw new Error("no tool")
		}

		expect(LOOP_PRESETS.desktop.supports(status)).toBe(true)
		expect(LOOP_PRESETS.shipped.supports(status)).toBe(false)
		expect(LOOP_PRESETS.loop.supports(status)).toBe(false)
	})

	it("runs the desktop cases and only them", () => {
		const desktop = [...EVAL_CASES, ...INJECTION_CASES].filter(item => item.app === "desktop")

		expect(desktop.length).toBeGreaterThan(50)

		for (const item of desktop) {
			expect(presetRunsCase("desktop", item), item.id).toBe(true)
			expect(presetRunsCase("shipped", item), item.id).toBe(false)
		}

		expect(presetRunsCase("desktop", {})).toBe(false)
		expect(presetRunsCase("shipped", {})).toBe(true)
		expect(presetRunsCase(null, {})).toBe(true)
	})
})

describe("open_route in the fake app", () => {
	it("opens sync, mounts and the desktop settings only in the desktop app, and plans only on the web", () => {
		for (const route of ["sync", "mounts", "settings_desktop"]) {
			expect(new FakeApp().execute({ name: "open_route", args: { route } }).ok, route).toBe(false)
			expect(new FakeApp({}, { desktop: true }).execute({ name: "open_route", args: { route } }).ok, route).toBe(true)
		}

		expect(new FakeApp().execute({ name: "open_route", args: { route: "settings_plans" } }).ok).toBe(true)
		expect(new FakeApp({}, { desktop: true }).execute({ name: "open_route", args: { route: "settings_plans" } }).ok).toBe(false)
		expect(new FakeApp().execute({ name: "open_route", args: { route: "videos" } }).ok).toBe(true)
	})
})
