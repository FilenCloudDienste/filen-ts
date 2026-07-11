import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

// A shared, named no-op — TS's fewer-params-is-assignable rule lets this satisfy any `(...) => void`
// callback signature (a required progress/step/dismiss callback a call site genuinely has nothing to
// do with), so callers never need their own throwaway `() => {}` literal (which
// @typescript-eslint/no-empty-function flags; a named declaration with a real comment body does not).
export function noop(): void {
	// Intentionally empty.
}
