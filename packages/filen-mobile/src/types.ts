import type { File, Dir, DecryptedFileMeta, DecryptedDirMeta, SharedDir, SharedFile, SharedRootDir } from "@filen/sdk-rs"

export type ExtraData = {
	size: bigint
	uuid: string
}

export type DriveItemFile = File &
	ExtraData & {
		decryptedMeta: DecryptedFileMeta | null
	}

export type DriveItemDirectory = Dir &
	ExtraData & {
		decryptedMeta: DecryptedDirMeta | null
	}

export type DriveItemFileShared = SharedFile &
	ExtraData & {
		decryptedMeta: DecryptedFileMeta | null
	}

export type DriveItemDirectorySharedNonRoot = SharedDir &
	ExtraData & {
		decryptedMeta: DecryptedDirMeta | null
	}

export type DriveItemDirectorySharedRoot = SharedRootDir &
	ExtraData & {
		decryptedMeta: DecryptedDirMeta | null
	}

export type DriveItem =
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
			data: DriveItemFileShared
	  }

export type DriveItemFileExtracted =
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

export type DriveItemDirectoryExtracted = Exclude<DriveItem, DriveItemFile>
