// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type { SqliteCheck, SqliteSchema } from "@/features/preview/lib/sqliteBrowser"
import type { SqliteDatabase, SqliteOpenOutcome } from "@/features/preview/lib/sqliteDatabase"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// The database viewer's states: a file that is no database, the table list with views and virtual tables (listed,
// never browsed), the WAL notice, and the integrity check: by itself up to 256 MiB, on demand above, damage replacing
// the grid with the card.

const { outcome, checks, worker } = vi.hoisted(() => ({
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
vi.mock("@/features/preview/components/sqliteTableGrid", () => ({
	SqliteTableGrid: ({ name, rows }: { name: string; rows: number }) => (
		<p>
			grid of {name}: {rows}
		</p>
	)
}))

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
			cell: () => Promise.resolve({ type: "null", bytes: 0, value: null }),
			nextId: () => 1
		}),
		count: () => Promise.resolve({ rows: 2, exact: true }),
		close: () => undefined,
		...overrides
	}
}

beforeEach(() => {
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

		expect(await screen.findByText("Not checked")).toBeTruthy()
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
})
