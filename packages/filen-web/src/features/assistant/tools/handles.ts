import type { Chat, Note } from "@filen/sdk-rs"
import { driveItemName, type Playlist } from "@filen/shared"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import type { AssistantHandleRef } from "@/features/assistant/runtime/executor"

// What a handle stands for. Snapshots as of when the model saw them; adapters re-read the live row
// from the caches before acting. `path` is the drive item's absolute path when a lookup knew it; `shared`
// the uuid chain from the shared-with-me root down to a directory someone else shares, which listing it
// needs (the route splat the Shared with me screen browses by).
export type AssistantEntity =
	| { kind: "root" }
	| { kind: "drive"; item: DriveItem; path?: string; shared?: readonly string[] }
	| { kind: "note"; note: Note }
	| { kind: "chat"; chat: Chat }
	| { kind: "playlist"; playlist: Playlist }
	// `playlist`: the playlist it was listed from, which a play queues from this track on.
	| { kind: "track"; track: QueueTrack; playlist?: Playlist }
	// An app_help result (its registry id) and a desktop sync pair (its id), named as the result showed them.
	| { kind: "help"; id: string; title: string }
	| { kind: "syncPair"; pairId: string; name: string }

export type AssistantEntityKind = AssistantEntity["kind"]

export interface AssistantHandleEntry {
	ref: AssistantHandleRef
	entity: AssistantEntity
}

export const ROOT_HANDLE = "d0"

const ROOT_NAME = "/"

function entityKey(entity: AssistantEntity): string {
	switch (entity.kind) {
		case "root":
			return "root"
		case "drive":
			return `drive:${entity.item.data.uuid}`
		case "note":
			return `note:${entity.note.uuid}`
		case "chat":
			return `chat:${entity.chat.uuid}`
		case "playlist":
			return `playlist:${entity.playlist.uuid}`
		case "track":
			return `track:${entity.track.uuid}`
		case "help":
			return `help:${entity.id}`
		case "syncPair":
			return `syncPair:${entity.pairId}`
	}
}

function handlePrefix(entity: AssistantEntity): string {
	switch (entity.kind) {
		case "root":
			return "d"
		case "drive":
			return isDirectoryItem(entity.item) ? "d" : "f"
		case "note":
			return "n"
		case "chat":
			return "c"
		case "playlist":
			return "p"
		case "track":
			return "t"
		case "help":
			return "h"
		case "syncPair":
			return "s"
	}
}

// Short handles for one conversation: a model copies "f3" reliably and mangles a UUID. One item keeps
// its handle for the whole conversation, so a handle from an earlier turn still names the same item.
export class AssistantHandleRegistry {
	private readonly byHandle = new Map<string, AssistantHandleEntry>()
	private readonly byKey = new Map<string, string>()
	// Per prefix, never reset on this page: a handle a reply named once never names another item.
	private readonly counters = new Map<string, number>()

	constructor() {
		this.clear()
	}

	register(entity: AssistantEntity, name: string): AssistantHandleRef {
		const key = entityKey(entity)
		const known = this.byKey.get(key)

		if (known !== undefined) {
			const previous = this.byHandle.get(known)?.entity
			// A later sighting without a path or shared chain keeps the one an earlier lookup found, while the item
			// still has the name and the directory that lookup found it with; its ancestors are checked where the
			// path is used.
			const kept =
				entity.kind === "drive" && previous?.kind === "drive"
					? {
							...entity,
							...(entity.path === undefined &&
							previous.path !== undefined &&
							previous.item.data.parent === entity.item.data.parent &&
							driveItemName(previous.item) === driveItemName(entity.item)
								? { path: previous.path }
								: {}),
							...(entity.shared === undefined && previous.shared !== undefined ? { shared: previous.shared } : {})
						}
					: entity
			const ref = { handle: known, name }

			this.byHandle.set(known, { ref, entity: kept })

			return ref
		}

		const prefix = handlePrefix(entity)
		const next = (this.counters.get(prefix) ?? 0) + 1
		const ref = { handle: `${prefix}${String(next)}`, name }

		this.counters.set(prefix, next)
		this.byKey.set(key, ref.handle)
		this.byHandle.set(ref.handle, { ref, entity })

		return ref
	}

	get(handle: string): AssistantHandleEntry | undefined {
		return this.byHandle.get(handle.trim())
	}

	entries(): AssistantHandleEntry[] {
		return [...this.byHandle.values()]
	}

	// A new conversation. `texts` are a resumed conversation's messages and replies: the handles they name
	// were handed out on an earlier page, so numbering continues past them, and such a stale handle reads as
	// unknown (the model looks the item up again) instead of naming whatever got its number here.
	clear(texts: readonly string[] = []): void {
		this.byHandle.clear()
		this.byKey.clear()

		for (const text of texts) {
			for (const [, prefix, number] of text.matchAll(/\b([dfncptsh])(\d{1,9})\b/g)) {
				if (prefix !== undefined && number !== undefined) {
					this.counters.set(prefix, Math.max(this.counters.get(prefix) ?? 0, Number(number)))
				}
			}
		}

		// The drive root is always "d0", as the model is told.
		this.byKey.set("root", ROOT_HANDLE)
		this.byHandle.set(ROOT_HANDLE, { ref: { handle: ROOT_HANDLE, name: ROOT_NAME }, entity: { kind: "root" } })
	}
}
