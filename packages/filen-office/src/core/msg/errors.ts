export type MsgErrorCode = "tooLarge" | "corrupt"

export class MsgError extends Error {
	readonly code: MsgErrorCode

	constructor(code: MsgErrorCode, message: string) {
		super(message)

		this.name = "MsgError"
		this.code = code
	}
}
