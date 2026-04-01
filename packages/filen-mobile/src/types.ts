import type { File, Dir, DecryptedFileMeta, DecryptedDirMeta, SharedDir, SharedFile, SharedRootDir } from "@filen/sdk-rs"

export type Prettify<T> = {
	[K in keyof T]: T[K]
} & {}

export type ExtraData = {
	size: bigint
	uuid: string
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
