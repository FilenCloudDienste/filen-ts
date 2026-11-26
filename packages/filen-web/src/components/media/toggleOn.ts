// A media player's pressed toggle (repeat, shuffle). Blue, as on mobile: --primary is a neutral a hair off --foreground,
// so an "on" tinted with it read as off. Keyed on aria-pressed so it also outranks the ghost variant's
// hover/aria-expanded foreground.
export const TOGGLE_ON_CLASS = "aria-pressed:text-blue-500"
