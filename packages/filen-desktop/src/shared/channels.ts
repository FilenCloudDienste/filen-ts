// IPC channel names shared by main and the preload; the renderer never sees them.
export const CHANNELS = {
	setTitleBarColors: "window:set-title-bar-colors"
} as const
