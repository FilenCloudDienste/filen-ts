import type { Dir, Note, SharedDir, AnyDirEnumWithShareInfo, Chat } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

const cache = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	secureStore: new Map<string, any>(),
	directoryUuidToName: new Map<string, string>(),
	directoryUuidToDir: new Map<string, Dir>(),
	noteUuidToNote: new Map<string, Note>(),
	sharedDirUuidToDir: new Map<string, SharedDir>(),
	sharedDirectoryUuidToDir: new Map<string, SharedDir>(),
	directoryUuidToAnyDirWithShareInfo: new Map<string, AnyDirEnumWithShareInfo>(),
	chatUuidToChat: new Map<string, Chat>(),
	uuidToDriveItem: new Map<string, DriveItem>()
}

export default cache
