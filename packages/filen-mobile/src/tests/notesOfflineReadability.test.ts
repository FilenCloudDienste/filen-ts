import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { QueryClient, QueryObserver, onlineManager } from "@tanstack/react-query"

/**
 * Issue #103: with the device offline, the notes screen spun forever and marked-offline notes were
 * unreachable — while the complete note list sat in the query cache, restored from disk at boot.
 *
 * The cause was reading a query's `status` instead of its `data`. `refetchOnMount: "always"` fires a
 * doomed request as the screen opens offline; it fails, and TanStack flips `status` to "error" while
 * KEEPING the data. Every `status === "success"` gate in the feature therefore evaluated false and
 * threw away a perfectly good offline list — and the note screens, which resolve their note out of
 * that same list, dismissed themselves on open.
 */

const SRC = path.join(__dirname, "..")
const FEATURES = path.join(SRC, "features")
const NOTES_FEATURE = path.join(FEATURES, "notes")

/**
 * Queries whose data is PERSISTED to SQLite and replayed at boot, so there is real content to draw
 * while offline and a status gate is always wrong. Deliberately a list rather than "every query":
 * the ones in UNCACHED_QUERY_KEYS (file bodies, biometric capability, camera-upload albums…) have
 * nothing on disk, so for them `status === "success"` and `data !== undefined` say the same thing
 * and rewriting them would be churn.
 */
const PERSISTED_QUERIES = [
	"notesQuery",
	"notesTagsQuery",
	"chatsQuery",
	"chatMessagesQuery",
	"chatMessageLinksQuery",
	"contactsQuery",
	"contactRequestsQuery",
	"playlistsQuery",
	"eventsQuery",
	"driveItemVersionsQuery"
]

/**
 * `accountQuery` is persisted too and is deliberately NOT here.
 *
 * Its subscription-tier reads (`userIsSubbed`, the plan subtitle) are the one place where showing
 * stale data is arguably worse than showing none, so those stay status-gated as a product decision.
 * The reads where staleness is plainly better — the storage bar, the avatar, and the
 * master-keys-not-exported warning — were converted, but the query still has status gates, so
 * listing it here would fail the scan for a reason that is not a bug.
 */
const DELIBERATELY_STATUS_GATED = ["accountQuery"]

/** The shape being hunted. ONE definition, so the self-test below cannot drift from the scan. */
const STATUS_GATE = /Query\.status\s*(===|!==)\s*"success"/

function statusGateFor(queries: readonly string[]): RegExp {
	return new RegExp(`\\b(${queries.join("|")})\\.status\\s*(===|!==)\\s*"success"`)
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap(entry => {
		const full = path.join(dir, entry)

		// The tests themselves quote the offending shape on purpose.
		if (entry === "tests") {
			return []
		}

		if (statSync(full).isDirectory()) {
			return sourceFiles(full)
		}

		return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : []
	})
}

describe("the contract this fix depends on", () => {
	it("keeps data when an offline refetch fails, and only flips status", async () => {
		// Pinned because the whole fix rests on it: if a TanStack upgrade started CLEARING data on a
		// failed refetch, reading `.data` would silently go back to showing nothing offline, and the
		// notes screen would regress to exactly the reported bug with no test failing anywhere else.
		onlineManager.setOnline(false)

		const client = new QueryClient()

		// Stand in for restoreQueries() replaying the persisted list at boot.
		client.setQueryData(["notes"], [{ uuid: "note-1" }])

		const observer = new QueryObserver(client, {
			queryKey: ["notes"],
			queryFn: () => Promise.reject(new Error("offline")),
			refetchOnMount: "always",
			retry: false,
			networkMode: "offlineFirst",
			staleTime: 0
		})

		const unsubscribe = observer.subscribe(() => {})

		await new Promise(resolve => setTimeout(resolve, 100))

		const result = observer.getCurrentResult()

		unsubscribe()
		onlineManager.setOnline(true)

		expect(result.status).toBe("error")
		expect(result.data).toEqual([{ uuid: "note-1" }])
	})
})

describe("notes feature reads query data, not fetch status", () => {
	it("has no status-equality gate on a query anywhere in the feature", () => {
		// A tripwire, not a style rule: every one of these gates is a screen that goes blank or
		// dismisses itself the moment the device is offline, and none of them looks wrong in review.
		const offenders: string[] = []

		for (const file of sourceFiles(NOTES_FEATURE)) {
			const source = readFileSync(file, "utf8")

			source.split("\n").forEach((line, index) => {
				if (STATUS_GATE.test(line)) {
					offenders.push(`${path.relative(NOTES_FEATURE, file)}:${index + 1}`)
				}
			})
		}

		expect(offenders).toEqual([])
	})

	it("no persisted query is gated on status anywhere under src", () => {
		// The same defect reached chats, contacts, playlists, events and file versions: an empty list
		// or a dead-end screen over content already on disk, plus a blocked-user filter that answered
		// "nobody is blocked" offline.
		//
		// Scans all of src, not just src/features — the first version of this guard stopped at
		// features and so stayed green while src/routes/tabs/_layout.tsx held a live offender on one
		// of the very queries listed here.
		const pattern = statusGateFor(PERSISTED_QUERIES)
		const offenders: string[] = []

		for (const file of sourceFiles(SRC)) {
			const source = readFileSync(file, "utf8")

			source.split("\n").forEach((line, index) => {
				if (pattern.test(line)) {
					offenders.push(`${path.relative(SRC, file)}:${index + 1}`)
				}
			})
		}

		expect(offenders).toEqual([])
	})

	it("self-test: the matchers still recognise the shape they guard against", () => {
		// Exercises the SAME constants the scans use. An earlier version re-declared its own copy of the
		// regex, so editing the scan pattern left this green — precisely the failure it claims to catch.
		expect(STATUS_GATE.test('const note = notesQuery.status === "success" ? data : null')).toBe(true)
		expect(STATUS_GATE.test('loading={notesQuery.status !== "success"}')).toBe(true)
		// The legitimate forms the feature now uses must NOT trip it.
		expect(STATUS_GATE.test('loading={notesQuery.status === "pending"}')).toBe(false)
		expect(STATUS_GATE.test("const note = notesQuery.data?.find(n => n.uuid === uuid) ?? null")).toBe(false)

		// And the per-query matcher, which is built from a list a typo could silently empty.
		const pattern = statusGateFor(PERSISTED_QUERIES)

		expect(PERSISTED_QUERIES.length).toBeGreaterThan(5)
		expect(pattern.test('const chats = chatsQuery.status === "success" ? chatsQuery.data : []')).toBe(true)
		expect(pattern.test('eventsQuery.status !== "success"')).toBe(true)
		expect(pattern.test('somethingElseQuery.status === "success"')).toBe(false)
		// The documented exclusion must stay excluded, or the scan fails for a non-bug.
		expect(DELIBERATELY_STATUS_GATED.some(name => PERSISTED_QUERIES.includes(name))).toBe(false)
	})

	it("still shows a spinner while there is genuinely nothing to draw", () => {
		// The other half of the fix: "pending" means no data yet, and that IS a spinner. Only the
		// error-with-data case had to stop being one.
		const listSource = readFileSync(path.join(NOTES_FEATURE, "components", "index.tsx"), "utf8")

		expect(listSource).toContain('loading={notesQuery.status === "pending"}')
		expect(listSource).toContain('loading={notesTagsQuery.status === "pending"}')
	})
})
