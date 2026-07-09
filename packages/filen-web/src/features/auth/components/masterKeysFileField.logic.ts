// Extracted from the file input's change handler purely for testability — vitest runs with no DOM
// (see vitest.config.ts), so this takes a minimal structural stand-in for a File rather than the real
// DOM type; a real File satisfies it as-is. Reads the file as plain text with NO parsing/validation of
// the master-key format — the SDK's completePasswordReset accepts its recoverKey param as raw or
// base64 and validates internally (never reimplement crypto/API logic client-side).
export interface MasterKeysFileLike {
	name: string
	text: () => Promise<string>
}

export interface MasterKeysFileRead {
	fileName: string
	text: string
}

export async function readMasterKeysFile(file: MasterKeysFileLike): Promise<MasterKeysFileRead> {
	const text = await file.text()
	return { fileName: file.name, text }
}
