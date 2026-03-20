import { EventEmitter } from "eventemitter3"
import type { ShowActionSheetOptions } from "@/providers/actionSheet.provider"
import type { NoteContentEdited, Contact } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import type { AudioStatus } from "expo-audio"
import type { Mode as AudioMode } from "@/lib/audio"

export type Events = {
	secureStoreChange: {
		key: string
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		value: any
	}
	secureStoreRemove: {
		key: string
	}
	secureStoreClear: void
	showFullScreenLoadingModal: void
	hideFullScreenLoadingModal: void
	forceHideFullScreenLoadingModal: void
	showActionSheet: ShowActionSheetOptions
	chatConversationDeleted: {
		uuid: string
	}
	noteContentEdited: {
		noteUuid: string
		contentEdited: NoteContentEdited
	}
	focusChatInput: {
		chatUuid: string
	}
	driveSelect:
		| {
				id: string
				selectedItems: DriveItem[]
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
	audioStatus: {
		mode: AudioMode
		status: AudioStatus
	}
	audioLoading: boolean
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
