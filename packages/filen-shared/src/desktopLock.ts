import { type } from "arktype"

// The desktop app lock's PIN: digits only, so the lock screen can offer a numeric keypad. Main validates every PIN the
// page sends with this; the page uses it to enable its submit buttons.
export const DESKTOP_PIN_MIN_LENGTH = 4
export const DESKTOP_PIN_MAX_LENGTH = 12

export const desktopPinSchema = type(new RegExp(`^\\d{${String(DESKTOP_PIN_MIN_LENGTH)},${String(DESKTOP_PIN_MAX_LENGTH)}}$`))
