// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type { SqliteCheck, SqliteSchema } from "@/features/preview/lib/sqliteBrowser"
import type { SqliteDatabase, SqliteOpenOutcome } from "@/features/preview/lib/sqliteDatabase"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { SQLITE_COUNT_CHUNK, SQLITE_FIRST_COUNT_CHUNK, SQLITE_TILE_ROWS } from "@/features/preview/lib/sqliteBrowse.logic"

// The database viewer's states: a file that is no database, the table list with views and virtual tables (listed,
// never browsed), the WAL notice, and the integrity check: by itself up to 256 MiB, on demand above, damage replacing
// the grid with the card.

const { outcome, checks, worker, grid } = vi.hoisted(() => ({
	grid: { reportsActive: false, renders: 0 },
	worker: { status: "ready", owned: {}, generation: 1 },
	outcome: { next: null as SqliteOpenOutcome | null },
	checks: { results: [] as Promise<SqliteCheck>[], runs: 0, cancels: 0 }
}))

vi.mock("@/lib/workers/ownedWorker", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/workers/ownedWorker")>()),
	useOwnedWorker: () => worker
}))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: () => Promise.resolve() } }))
vi.mock("@/features/preview/lib/sqliteDatabase", () => ({
	SQLITE_COUNT_IDLE_MS: 500,
	createSqliteWorker: () => undefined,
	openSqliteDatabase: () => Promise.resolve(outcome.next),
	runSqliteCheck: () => {
		checks.runs++

		return {
			result: checks.results.shift() ?? Promise.resolve("ok"),
			cancel: () => {
				checks.cancels++
			}
		}
	}
}))
vi.mock("@/features/preview/components/sqliteTableGrid", async () => {
	const { useEffect } = await import("react")

	// A grid that reports its active cell whenever its callback changes, as an uncompiled parent hands it a new one each
	// render.
	function SqliteTableGrid({ name, rows, onActive }: { name: string; rows: number; onActive: (row: number, col: number) => void }) {
		grid.renders++
		useEffect(() => {
			if (grid.reportsActive) onActive(1, 0)
		}, [onActive])

		return (
			<p>
				grid of {name}: {rows}
			</p>
		)
	}

	return { SqliteTableGrid }
})

const SCHEMA: SqliteSchema = {
	wal: false,
	tables: [
		{
			name: "users",
			kind: "table",
			sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)",
			columns: [
				{ name: "id", type: "INTEGER", pk: 1 },
				{ name: "email", type: "TEXT", pk: 0 }
			]
		},
		{ name: "notes", kind: "virtual", sql: "CREATE VIRTUAL TABLE notes USING fts5(body)", columns: [] },
		{
			name: "notes_content",
			kind: "table",
			sql: "CREATE TABLE notes_content (id INTEGER PRIMARY KEY, c0)",
			columns: [{ name: "id", type: "INTEGER", pk: 1 }]
		},
		{ name: "emails", kind: "view", sql: "CREATE VIEW emails AS SELECT email FROM users", columns: [] }
	]
}

function database(overrides: Partial<SqliteDatabase> = {}): SqliteDatabase {
	return {
		schema: SCHEMA,
		size: 4096,
		ranged: true,
		autoCheck: true,
		lastRead: () => 0,
		reads: () => ({
			tiles: () => Promise.resolve([]),
			cell: () => Promise.resolve({ type: "null", bytes: 0, value: null })
		}),
		count: () => Promise.resolve({ rows: 2, exact: true }),
		stopCount: () => undefined,
		reach: () => 0,
		onReach: () => () => undefined,
		onUnreadable: () => () => undefined,
		close: () => undefined,
		...overrides
	}
}

beforeEach(() => {
	grid.reportsActive = false
	grid.renders = 0
	checks.results = []
	checks.runs = 0
	checks.cancels = 0
})

afterEach(() => {
	cleanup()
})

async function renderViewer(): Promise<void> {
	const { SqliteViewer } = await import("@/features/preview/components/sqliteViewer")

	render(<SqliteViewer item={linkedFileItem("app.sqlite")} />)
}

describe("SqliteViewer", () => {
	it("says a file that is no database is none, with the card", async () => {
		outcome.next = { ok: false, reason: "notSqlite" }
		await renderViewer()

		expect(await screen.findByText("Not a SQLite database (or encrypted).")).toBeTruthy()
	})

	it("lists tables, views and virtual tables, shows the first table's rows, and never browses a virtual table", async () => {
		outcome.next = { ok: true, database: database() }
		await renderViewer()

		expect(await screen.findByText("grid of users: 2")).toBeTruthy()
		expect(screen.getByText("Tables (2)")).toBeTruthy()
		expect(screen.getByText("Views (1)")).toBeTruthy()
		expect(screen.getByText("Virtual (1)")).toBeTruthy()
		expect(screen.getByText(/2 rows/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "notes" }))

		expect(await screen.findByText("Virtual table — not browsed.")).toBeTruthy()
		expect(screen.getByText("CREATE VIRTUAL TABLE notes USING fts5(body)")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "emails" }))

		expect(await screen.findByText("View — its SQL is shown, it is not run.")).toBeTruthy()
	})

	it("says changes in a WAL file are not shown", async () => {
		outcome.next = { ok: true, database: database({ schema: { ...SCHEMA, wal: true } }) }
		await renderViewer()

		expect(await screen.findByText("Changes still in the WAL file are not shown.")).toBeTruthy()
	})

	it("checks a small database by itself and shows it checked", async () => {
		outcome.next = { ok: true, database: database() }
		await renderViewer()

		expect(await screen.findByText("Checked")).toBeTruthy()
		expect(checks.runs).toBe(1)
	})

	it("replaces the grid with the card when the check finds damage", async () => {
		checks.results.push(Promise.resolve("damaged"))
		outcome.next = { ok: true, database: database() }
		await renderViewer()

		expect(await screen.findByText("The database is damaged.")).toBeTruthy()
		expect(screen.queryByText(/grid of/)).toBeNull()
	})

	it("opens a large database unchecked, checks it when asked, and leaves it unchecked on Cancel", async () => {
		const pending = Promise.withResolvers<SqliteCheck>()

		checks.results.push(pending.promise)
		outcome.next = { ok: true, database: database({ autoCheck: false, size: 300 * 1024 * 1024 }) }
		await renderViewer()

		// Its own element, so a full-text lookup (an e2e locator) finds it apart from the button beside it.
		expect((await screen.findByText("Not checked")).textContent).toBe("Not checked")
		expect(checks.runs).toBe(0)

		fireEvent.click(screen.getByRole("button", { name: "Check integrity" }))

		expect(await screen.findByText("Checking…")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		pending.resolve("cancelled")

		await waitFor(() => {
			expect(screen.getByText("Not checked")).toBeTruthy()
		})
		expect(checks.cancels).toBe(1)
	})

	it("counts a database read in ranges only as far as the grid reads, and every row only on Count, which Cancel stops", async () => {
		const chunks: number[] = []
		const stops = vi.fn()
		let rows = 0
		const total = 100_000
		const pending: ((value: { rows: number; exact: boolean } | null) => void)[] = []

		outcome.next = {
			ok: true,
			database: database({
				count: (_table, chunk) => {
					chunks.push(chunk)

					// The Count steps wait until the test lets them through.
					if (chunk === SQLITE_COUNT_CHUNK) return new Promise(resolve => pending.push(resolve))

					rows = Math.min(total, rows === 0 ? SQLITE_FIRST_COUNT_CHUNK : rows + chunk)

					return Promise.resolve({ rows, exact: rows === total })
				},
				stopCount: stops
			})
		}
		await renderViewer()

		// The first tile's rows, and no more while the grid reads no further; the grid shows one tile past them.
		expect(await screen.findByText(/≥ 63 rows/)).toBeTruthy()
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(screen.getByText(/≥ 63 rows/)).toBeTruthy()
		expect(screen.getByText(`grid of users: ${String(63 + SQLITE_TILE_ROWS)}`)).toBeTruthy()
		expect(chunks).toHaveLength(1)

		fireEvent.click(screen.getByRole("button", { name: "Count" }))

		expect(await screen.findByText("Counting…")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		pending.shift()?.(null)

		expect(await screen.findByRole("button", { name: "Count" })).toBeTruthy()
		expect(stops).toHaveBeenCalledOnce()

		fireEvent.click(screen.getByRole("button", { name: "Count" }))
		await waitFor(() => {
			expect(pending).toHaveLength(1)
		})
		pending.shift()?.({ rows: total, exact: true })

		expect(await screen.findByText(/100,000 rows/)).toBeTruthy()
		expect(screen.queryByText(/≥/)).toBeNull()
		expect(screen.queryByRole("button", { name: "Count" })).toBeNull()
	})

	it("counts on as the grid scrolls past what is counted", async () => {
		let rows = 0
		let reach: ((table: number, row: number) => void) | null = null

		outcome.next = {
			ok: true,
			database: database({
				count: (_table, chunk) => {
					rows = rows === 0 ? SQLITE_FIRST_COUNT_CHUNK : rows + chunk

					return Promise.resolve({ rows, exact: false })
				},
				onReach: listener => {
					reach = listener

					return () => undefined
				}
			})
		}
		await renderViewer()

		expect(await screen.findByText(/≥ 63 rows/)).toBeTruthy()

		// The grid asked for rows as far as 1,000: counting follows it there.
		act(() => {
			reach?.(0, 1000)
		})

		expect(await screen.findByText(/≥ 1,000 rows/)).toBeTruthy()
	})

	it("counts a database read whole to the end by itself, with no Count", async () => {
		const chunks: number[] = []
		let rows = 0

		outcome.next = {
			ok: true,
			database: database({
				ranged: false,
				count: (_table, chunk) => {
					chunks.push(chunk)
					rows += rows === 0 ? SQLITE_FIRST_COUNT_CHUNK : chunk

					return Promise.resolve({ rows: Math.min(rows, 120_000), exact: rows >= 120_000 })
				}
			})
		}
		await renderViewer()

		expect(await screen.findByText(/120,000 rows/, undefined, { timeout: 3000 })).toBeTruthy()
		expect(chunks.slice(1).every(chunk => chunk === SQLITE_COUNT_CHUNK)).toBe(true)
		expect(screen.queryByRole("button", { name: "Count" })).toBeNull()
	})

	it("shows the unreadable card with Retry when a read fails after opening", async () => {
		const listeners: (() => void)[] = []

		outcome.next = {
			ok: true,
			database: database({
				onUnreadable: listener => {
					listeners.push(listener)

					return () => undefined
				}
			})
		}
		await renderViewer()
		await screen.findByText("grid of users: 2")

		act(() => {
			for (const listener of listeners) listener()
		})

		expect(screen.getByText("Couldn't read the database.")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
	})

	it("settles when the grid reports the same active cell again", async () => {
		grid.reportsActive = true
		outcome.next = { ok: true, database: database() }
		await renderViewer()

		expect(await screen.findByText("users.id, row 1")).toBeTruthy()
		await new Promise(resolve => setTimeout(resolve, 50))
		// Rendered a few times, never in a loop.
		expect(grid.renders).toBeLessThan(10)
	})
})
