import { type } from "arktype"

// The desktop app lock's PIN: digits only, so the lock screen can offer a numeric keypad. Main validates every PIN the
// page sends with this; the page uses it to enable its submit buttons.
export const DESKTOP_PIN_MIN_LENGTH = 4
export const DESKTOP_PIN_MAX_LENGTH = 12

export const desktopPinSchema = type(new RegExp(`^\\d{${String(DESKTOP_PIN_MIN_LENGTH)},${String(DESKTOP_PIN_MAX_LENGTH)}}$`))

// "Lock after" choices for the desktop app lock, in seconds of no input in Filen's windows (hidden time included);
// 0 is Never, which still locks at launch, on Lock now and with the OS screen lock. Main's prefs schema, the 3.x import
// and the settings select all read this list.
export const DESKTOP_LOCK_AFTER_SECONDS = [0, 60, 180, 300, 600, 1800, 3600, 10800, 21600, 43200, 86400] as const

export type DesktopLockAfterSeconds = (typeof DESKTOP_LOCK_AFTER_SECONDS)[number]

export const DEFAULT_DESKTOP_LOCK_AFTER_SECONDS: DesktopLockAfterSeconds = 300
