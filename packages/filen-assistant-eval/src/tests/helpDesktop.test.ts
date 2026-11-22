import { describe, expect, it } from "vitest"
import { APP_HELP } from "@filen/shared/assistant"
import { FakeApp } from "../fakeApp"
import { HELP_ROWS } from "../fixture"

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
