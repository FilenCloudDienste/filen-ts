// Injectable blob-URL registry, so services that mint and revoke URLs are unit-testable without one.
export interface ObjectUrlFns {
	createObjectUrl: (blob: Blob) => string
	revokeObjectUrl: (url: string) => void
}

export const defaultObjectUrlFns: ObjectUrlFns = {
	createObjectUrl: blob => URL.createObjectURL(blob),
	revokeObjectUrl: url => {
		URL.revokeObjectURL(url)
	}
}
