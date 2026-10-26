// IPC channel names shared by main and the preload; the renderer never sees them.
export const CHANNELS = {
	setTitleBarColors: "window:set-title-bar-colors",
	sessionGet: "session:get",
	sessionSet: "session:set",
	sessionClear: "session:clear"
} as const

// What `session:get` answers. An error thrown by an IPC handler reaches the preload only as a wrapped message, so
// the unreadable case travels as data and the preload turns it into the rejection the bridge documents.
export type SessionRead = { status: "absent" } | { status: "present"; blob: string } | { status: "unreadable" }
