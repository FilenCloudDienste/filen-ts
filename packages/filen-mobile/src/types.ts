import { type File, type Dir, type DecryptedFileMeta, type DecryptedDirMeta, type SharedDir, type SharedFile } from "@filen/sdk-rs"

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

export type DriveItemDirectoryShared = SharedDir &
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
			data: DriveItemDirectoryShared
	  }
	| {
			type: "sharedFile"
			data: DriveItemFileShared
	  }
