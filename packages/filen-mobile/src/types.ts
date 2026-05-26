import {
	type File,
	type Dir,
	type DecryptedFileMeta,
	type DecryptedDirMeta,
	type SharedDir,
	type SharedFile,
	type SharedRootDir,
	type Note as SdkNote,
	type Chat as SdkChat,
	type ChatMessage as SdkChatMessage,
	type NoteTag as SdkNoteTag,
	type NoteHistory as SdkNoteHistory,
	type NoteParticipant as SdkNoteParticipant
} from "@filen/sdk-rs"

export type Prettify<T> = {
	[K in keyof T]: T[K]
} & {}

export type ExtraData = {
	size: bigint
	uuid: string
	undecryptable: boolean
}

export type DriveItemFile = Prettify<
	File &
		ExtraData & {
			decryptedMeta: DecryptedFileMeta | null
		}
>

export type DriveItemDirectory = Prettify<
	Dir &
		ExtraData & {
			decryptedMeta: DecryptedDirMeta | null
		}
>

export type DriveItemFileSharedNonRoot = Prettify<
	File &
		SharedFile &
		ExtraData & {
			decryptedMeta: DecryptedFileMeta | null
		}
>

export type DriveItemFileSharedRoot = Prettify<
	SharedFile &
		ExtraData & {
			decryptedMeta: DecryptedFileMeta | null
		}
>

export type DriveItemDirectorySharedNonRoot = Prettify<
	SharedDir &
		ExtraData & {
			decryptedMeta: DecryptedDirMeta | null
		}
>

export type DriveItemDirectorySharedRoot = Prettify<
	SharedRootDir &
		ExtraData & {
			decryptedMeta: DecryptedDirMeta | null
		}
>

export type DriveItem = Prettify<
	| {
			type: "directory"
			data: DriveItemDirectory
	  }
	| {
			type: "file"
			data: DriveItemFile
	  }
	| {
			type: "sharedDirectory"
			data: DriveItemDirectorySharedNonRoot
	  }
	| {
			type: "sharedRootDirectory"
			data: DriveItemDirectorySharedRoot
	  }
	| {
			type: "sharedFile"
			data: DriveItemFileSharedNonRoot
	  }
	| {
			type: "sharedRootFile"
			data: DriveItemFileSharedRoot
	  }
>

export type DriveItemFileExtracted = Prettify<
	| Extract<
			DriveItem,
			{
				type: "file"
			}
	  >
	| Extract<
			DriveItem,
			{
				type: "sharedFile"
			}
	  >
	| Extract<
			DriveItem,
			{
				type: "sharedRootFile"
			}
	  >
>

export type DriveItemDirectoryExtracted = Prettify<Exclude<DriveItem, DriveItemFileExtracted>>

export type CacheItem =
	| {
			type: "drive"
			data: DriveItem
	  }
	| {
			type: "external"
			data: {
				url: string
				name: string
			}
	  }

export type Note = SdkNote & {
	undecryptable: boolean
}

export type Chat = SdkChat & {
	undecryptable: boolean
}

export type ChatMessage = SdkChatMessage & {
	undecryptable: boolean
}

export type NoteTag = SdkNoteTag & {
	undecryptable: boolean
}

export type NoteHistory = SdkNoteHistory

export type NoteParticipant = SdkNoteParticipant
