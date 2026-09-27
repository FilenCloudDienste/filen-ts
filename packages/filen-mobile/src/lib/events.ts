import { EventEmitter } from "eventemitter3"
import type { ShowActionSheetOptions } from "@/providers/actionSheet.provider"
import type { NoteContentEdited, Contact, AnyNormalDir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import type { AudioStatus } from "expo-audio"
import type { QueueItem, PlaylistWithItems } from "@/features/audio/audio"

export type DriveFileGoneReason = "trashed" | "deleted" | "replaced"

export type Events = {
	secureStoreChange: {
		key: string
		value: unknown
	}
	secureStoreRemove: {
		key: string
	}
	secureStoreClear: void
	biometricEnabledInSession: void
	// Fired at the start of doLogout() teardown, before the SDK clients are destroyed — lets
	// component-land singletons (e.g. the gallery video players / a live PiP window, the shell socket's
	// listener) tear down without lib/auth importing native-backed component modules.
	logout: void
	showFullScreenLoadingModal: void
	hideFullScreenLoadingModal: void
	forceHideFullScreenLoadingModal: void
	showActionSheet: ShowActionSheetOptions
	chatConversationDeleted: {
		uuid: string
	}
	driveItemUpdated: {
		previousUuid: string
		item: DriveItem
	}
	driveItemRemoved: {
		uuid: string
	}
	// A newer version of a file was saved (a FileNew of the same lineage, whoever saved it: this device's
	// own save included) or restored (FileArchiveRestored, naming the version it replaced). An open
	// editor of the file follows it, or asks first over unsaved edits (useRemoteRevisions).
	driveFileRevised: {
		item: DriveItem
		previousUuid?: string
	}
	// A file was trashed, deleted for good, or replaced by another file under its name (its lineage ended) on
	// the server, from any client. An open editor holding unsaved edits of it asks what to do with them.
	driveFileGone: {
		uuid: string
		reason: DriveFileGoneReason
		// The file's stable id, when the event or the cache tells it.
		stableUuid?: string | undefined
	}
	// A trashed file was restored from the trash, from any client: an open editor no longer treats it as gone.
	driveFileRestored: {
		uuid: string
		stableUuid?: string | undefined
	}
	// A drive event arrived that the SDK could not read: some change happened that nothing was told of.
	driveChangesMissed: void
	// The drive preview's unsaved-changes guard blocked a route pop (user chose Cancel, or the
	// save failed): the gallery must unwind its one-shot navigate-back latch so the close
	// button works again.
	drivePreviewDismissBlocked: void
	// A note's content was edited by someone else or on another device (never this device's own push
	// coming back: the notes socket handler drops those), or a sync pass found such an edit under an open
	// editor's unsynced edits (no `contentEdited` then). `content` is what arrived, undefined when it could
	// not be decrypted.
	noteContentEdited: {
		noteUuid: string
		contentEdited?: NoteContentEdited
		content: string | undefined
	}
	focusChatInput: {
		chatUuid: string
	}
	driveSelect:
		| {
				id: string
				selectedItems: (
					| {
							type: "driveItem"
							data: DriveItem
					  }
					| {
							type: "root"
							data: AnyNormalDir
					  }
				)[]
				cancelled: false
		  }
		| {
				id: string
				cancelled: true
		  }
	contactsSelect:
		| {
				id: string
				selectedContacts: Contact[]
				cancelled: false
		  }
		| {
				id: string
				cancelled: true
		  }
	audioStatus: AudioStatus
	audioLoading: boolean
	audioQueue: QueueItem[]
	audioQueuePosition: number
	playlistsSelect:
		| {
				id: string
				selectedPlaylists: PlaylistWithItems[]
				cancelled: false
		  }
		| {
				id: string
				cancelled: true
		  }
}

class TypedEventEmitter<T> {
	private readonly emitter = new EventEmitter()

	public subscribe<K extends keyof T>(event: K, listener: (payload: T[K]) => void) {
		this.emitter.addListener(event as string, listener)

		return {
			remove: () => {
				this.emitter.removeListener(event as string, listener)
			}
		}
	}

	public emit<K extends keyof T>(event: K, payload?: T[K]): boolean {
		return this.emitter.emit(event as string, payload)
	}

	public on<K extends keyof T>(event: K, listener: (payload: T[K]) => void): this {
		this.emitter.on(event as string, listener)

		return this
	}

	public once<K extends keyof T>(event: K, listener: (payload: T[K]) => void): this {
		this.emitter.once(event as string, listener)

		return this
	}

	public off<K extends keyof T>(event: K, listener: (payload: T[K]) => void): this {
		this.emitter.off(event as string, listener)

		return this
	}
}

const events = new TypedEventEmitter<Events>()

export default events
