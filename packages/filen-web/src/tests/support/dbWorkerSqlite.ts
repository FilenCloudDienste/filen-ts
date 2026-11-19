type SqliteModule = typeof import("@sqlite.org/sqlite-wasm")
type MemoryConnection = InstanceType<Awaited<ReturnType<SqliteModule["default"]>>["oo1"]["DB"]>

// The sqlite-wasm module the db worker loads, with only the OPFS pool install swapped out: every pool
// connection is a fresh in-memory database over the package's real node build, so the SQL the worker runs
// is exactly what ships. vi.mock factories are hoisted, so a test reaches this through an awaited import:
//
//   vi.mock("@sqlite.org/sqlite-wasm", async importOriginal =>
//       (await import("@/tests/support/dbWorkerSqlite")).memorySqliteModule(await importOriginal(), { ... }))
export function memorySqliteModule(
	actual: SqliteModule,
	{ onOpen, wipeFiles }: { onOpen: (db: MemoryConnection) => void; wipeFiles: () => Promise<void> }
): { default: () => Promise<unknown> } {
	return {
		default: async () => {
			const sqlite3 = await actual.default()

			class MemoryDb extends sqlite3.oo1.DB {
				public constructor() {
					super(":memory:")
					onOpen(this)
				}
			}

			return { installOpfsSAHPoolVfs: () => Promise.resolve({ OpfsSAHPoolDb: MemoryDb, wipeFiles }) }
		}
	}
}
