import { type } from "arktype"
import * as Comlink from "comlink"
import { createNotePreviewFromContentText } from "@filen/utils"
import type { StringifiedClient, File, Note, NoteType } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { kvGetJson, kvHas, kvSetJson } from "@/lib/storage/adapter"
import { comboFor, setUserCombo } from "@/lib/keymap/registry"
import { persistSession, resumeSession } from "@/lib/sdk/session"
import { whenBootReady } from "@/lib/sdk/boot"
import { readThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { log } from "@/lib/log"

// Test-only hooks, loaded ONLY when the app is built with VITE_E2E=1 (a dynamic import behind that
// env condition in main.tsx, so a normal build dead-code-eliminates this whole module — proven by
// the no-flag build grep). Nothing here ships to production.
//
// The e2e harness never types credentials or the session blob into the UI: it logs in once
// (`mint`), stores the resulting blob to a file, and re-seeds it on later loads via sessionStorage,
// which `seedFromSlot` moves into the worker + kv through the app's own code paths. The blob carries
// a bigint (`StringifiedClient.userId`), so it always travels as an envelope STRING (@/lib/serialize),
// never raw JSON.

const SESSION_SLOT = "filen.e2e.session"

// Test kv probes go through the normal adapter, which requires an arktype schema on read.
const stringSchema = type("string")

interface E2eHooks {
	// Logs in and returns the session blob as an envelope string (bigint-safe, ready to persist).
	// Documented fallback for auth-setup's real-form login (see auth.setup.ts) — kept working in case
	// the form path ever proves too flaky to drive from Playwright.
	mint: (email: string, password: string) => Promise<string>
	// Re-stringifies the WORKER'S currently-live client (not the kv copy — see dumpSession) into the
	// same envelope-string shape mint returns. Used by auth-setup to harvest the session after driving
	// the real login form, so the harness gets genuine UI coverage from the one login the budget allows.
	dumpSession: () => Promise<string>
	// A single authenticated read against the API — proves an injected session actually authenticates.
	probeAuthedRead: () => Promise<boolean>
	kvSet: (key: string, value: string) => Promise<void>
	kvGet: (key: string) => Promise<string | null>
	// Raw existence check, independent of schema — kvGet/kvGetJson return null for BOTH "absent" and
	// "present but the wrong shape for the schema this hook happens to validate with", which makes
	// kvGet useless for proving a key is genuinely gone (e.g. asserting a wipe) unless the caller also
	// holds that exact schema. Used by auth.spec's logout test to check the session key without
	// depending on sessionSchema.
	kvHas: (key: string) => Promise<boolean>
	setUserCombo: (actionId: string, combo: string) => Promise<void>
	comboFor: (actionId: string) => string
	// Raw (non-enveloped) client blob for handing straight to the service worker's own
	// SW_MSG_INIT_CLIENT handshake from inside a page.evaluate callback — bigint fields survive the
	// postMessage structured clone there, unlike the JSON-only Playwright<->page bridge dumpSession is
	// stringified for. Used by the sw zip e2e case, which drives the SW protocol directly rather than
	// through a real Download click (Chromium's File System Access API would otherwise take the fsa
	// branch, the one path that can never reach the sw route under test).
	rawStringifiedClient: () => Promise<StringifiedClient>
	// Uploads one small real file through the real worker path (no UI) and returns the resulting File
	// record — gives the sw zip e2e case real, live-downloadable ZipItems without depending on whatever
	// the shared e2e account happens to already hold. `parentUuid` defaults to the drive root; callers
	// nesting inside a scratch directory (net-zero on the shared account) pass its uuid explicitly.
	createTestFile: (name: string, content: string, parentUuid?: string | null) => Promise<File>
	// Trashes a File this hook created — keeps the shared e2e account net-zero after a test run.
	trashTestFile: (file: File) => Promise<void>
	// Permanently removes a note by uuid — trashes then deletes — keeping the shared e2e account
	// net-zero after a UI-driven create smoke test (this shell has no trash/delete UI yet; that lands
	// in the actions step). No-op when the uuid isn't found.
	deleteTestNoteByUuid: (uuid: string) => Promise<void>
	// Creates a note, switches it to `noteType` (a no-op for the SDK's own "text" default), writes
	// `content` with a matching preview, and renames it to `title` — the worker seam every read-only
	// reader test drives content through, with no editor UI required yet (this shell has no live
	// editing until the sync-outbox wave). `title` is a distinctive string a spec can locate in the
	// sidebar via the search box (rather than depending on the SDK's own default title, which carries
	// no test-chosen identity). Returns the final Note row for the caller to navigate to and later pass
	// to deleteTestNoteByUuid for net-zero teardown.
	createTestNoteWithContent: (noteType: NoteType, content: string, title: string) => Promise<Note>
	// Defensive sweep, same rationale as e2e/setup/cleanup.setup.ts's drive-side scratch-debris sweep:
	// the FREE e2e account's note cap is a hard 10 (server-enforced `note_limit_reached`), far tighter
	// than drive's storage quota, so ANY spec that dies before its own teardown compounds into real,
	// suite-wide failures far sooner than a stray drive item would. Trashes+deletes every note whose
	// title starts with `prefix`. Returns the count removed.
	sweepTestNotesByTitlePrefix: (prefix: string) => Promise<number>
	// Reads one cached thumbnail's on-disk size + write time, found by file name inside a parent
	// directory. The only way to prove a repaint after a real page reload came from the existing OPFS
	// cache entry rather than a fresh generation: a regenerate rewrites the file (a new
	// lastModified), a cache hit never touches the write path. Null when the file or its cache entry
	// doesn't exist.
	thumbnailFileStat: (parentUuid: string, name: string) => Promise<{ size: number; lastModified: number } | null>
}

// Minimal shape of the TanStack router main.tsx hands in — enough to re-run route guards after the
// session is injected. `to` is narrowed to the one route the hook navigates to ("/") so the real,
// strictly-typed router is structurally assignable here without a cast at the call site.
interface RouterLike {
	navigate: (opts: { to: "/" }) => Promise<unknown>
}

declare global {
	interface Window {
		__filenE2E?: E2eHooks
	}
}

// If a session blob was seeded into sessionStorage (by the injection fixture), drive it through the
// PRODUCTION session path — persist to kv, then resume (validate → inject into the worker) — so the
// harness exercises the real save/restore round-trip rather than a bespoke write. Then clear the
// one-shot slot and re-run the route guards. On this first seeded load the guards ran during boot
// (kv still empty) and landed unauthed; a client-side navigation (never a reload — that would drop
// the just-injected worker state) mirrors the real post-login transition and lets the authed shell
// render. On a later reload the blob is already in kv, so bootSdk's own resumeSession authenticates
// before the guards read hasClient() — no navigation needed.
async function seedFromSlot(router: RouterLike): Promise<void> {
	const raw = sessionStorage.getItem(SESSION_SLOT)

	if (raw === null) {
		return
	}

	sessionStorage.removeItem(SESSION_SLOT)

	await whenBootReady()

	const blob = parseEnvelope(raw) as StringifiedClient

	await persistSession(blob)
	await resumeSession()
	await router.navigate({ to: "/" })
}

export function installE2eHooks(router: RouterLike): void {
	window.__filenE2E = {
		mint: async (email, password) => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.login({ email, password }))
		},
		dumpSession: async () => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.toStringified())
		},
		probeAuthedRead: () => sdkApi.probeAuthedRead(),
		kvSet: (key, value) => kvSetJson(key, value),
		kvGet: key => kvGetJson(key, stringSchema),
		kvHas: key => kvHas(key),
		setUserCombo: (actionId, combo) => setUserCombo(actionId, combo),
		comboFor: actionId => comboFor(actionId),
		rawStringifiedClient: async () => {
			await whenBootReady()

			return sdkApi.toStringified()
		},
		createTestFile: async (name, content, parentUuid = null) => {
			await whenBootReady()

			return sdkApi.uploadFile(
				parentUuid,
				crypto.randomUUID(),
				new File([content], name, { type: "text/plain" }),
				Comlink.proxy(() => undefined)
			)
		},
		trashTestFile: async file => {
			await sdkApi.trashFile(file)
		},
		deleteTestNoteByUuid: async uuid => {
			await whenBootReady()

			const note = (await sdkApi.listNotes()).find(n => n.uuid === uuid)

			if (note === undefined) {
				return
			}

			// deleteNote is permanent; trash first so a note in any lifecycle state is removable.
			await sdkApi.deleteNote(await sdkApi.trashNote(note))
		},
		createTestNoteWithContent: async (noteType, content, title) => {
			await whenBootReady()

			let note = await sdkApi.createNote()

			// The SDK creates every note as "text" by default — only switch when a different type was
			// asked for. `knownContent` is omitted: the fresh note has no content yet, so there is
			// nothing meaningful to pass, and the SDK resolves it itself.
			if (noteType !== "text") {
				note = await sdkApi.setNoteType(note, noteType)
			}

			const previewType = noteType === "rich" || noteType === "checklist" ? noteType : "other"

			note = await sdkApi.setNoteContent(note, content, createNotePreviewFromContentText(previewType, content))
			note = await sdkApi.setNoteTitle(note, title)

			return note
		},
		sweepTestNotesByTitlePrefix: async prefix => {
			await whenBootReady()

			const matches = (await sdkApi.listNotes()).filter(n => (n.title ?? "").startsWith(prefix))

			for (const note of matches) {
				// deleteNote is permanent; trash first so a note in any lifecycle state is removable.
				// Sequential (not Promise.all): a bulk sweep racing many notes through the same worker
				// gains nothing from parallelism here and is easier to reason about mid-failure.
				await sdkApi.deleteNote(await sdkApi.trashNote(note))
			}

			return matches.length
		},
		thumbnailFileStat: async (parentUuid, name) => {
			await whenBootReady()

			// listDirectory returns raw SDK File records, not app-level DriveItems — meta arrives as the
			// tagged union (mirrors features/drive/lib/item.ts's own narrowItem extraction) rather than the
			// pre-narrowed decryptedMeta field the drive UI reads.
			const { files } = await sdkApi.listDirectory({ kind: "uuid", uuid: parentUuid })
			const file = files.find(f => f.meta.type === "decoded" && f.meta.data.name === name)

			if (file === undefined) {
				return null
			}

			const blob = await readThumbnailBlob(file.uuid)

			if (blob === null) {
				return null
			}

			// size/lastModified live on the runtime File the store's own getFile() returns; the read
			// side's own return type widens it to Blob, so the extra field is asserted here rather than
			// imported (avoids shadowing this file's own SDK File type import above).
			const stat = blob as Blob & { lastModified: number }

			return { size: stat.size, lastModified: stat.lastModified }
		}
	}

	void seedFromSlot(router).catch((e: unknown) => {
		log.error("e2e", "session seed failed", e)
	})
}
