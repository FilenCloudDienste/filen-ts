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

const NOTES_FEATURE = path.join(__dirname, "..", "features", "notes")

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap(entry => {
		const full = path.join(dir, entry)

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
				if (/Query\.status\s*(===|!==)\s*"success"/.test(line)) {
					offenders.push(`${path.relative(NOTES_FEATURE, file)}:${index + 1}`)
				}
			})
		}

		expect(offenders).toEqual([])
	})

	it("self-test: the matcher still recognises the shape it is guarding against", () => {
		// Without this, a typo in the pattern above turns the guard into a permanent pass.
		const pattern = /Query\.status\s*(===|!==)\s*"success"/

		expect(pattern.test('const note = notesQuery.status === "success" ? data : null')).toBe(true)
		expect(pattern.test('loading={notesQuery.status !== "success"}')).toBe(true)
		// The legitimate forms the feature now uses must NOT trip it.
		expect(pattern.test('loading={notesQuery.status === "pending"}')).toBe(false)
		expect(pattern.test("const note = notesQuery.data?.find(n => n.uuid === uuid) ?? null")).toBe(false)
	})

	it("still shows a spinner while there is genuinely nothing to draw", () => {
		// The other half of the fix: "pending" means no data yet, and that IS a spinner. Only the
		// error-with-data case had to stop being one.
		const listSource = readFileSync(path.join(NOTES_FEATURE, "components", "index.tsx"), "utf8")

		expect(listSource).toContain('loading={notesQuery.status === "pending"}')
		expect(listSource).toContain('loading={notesTagsQuery.status === "pending"}')
	})
})
