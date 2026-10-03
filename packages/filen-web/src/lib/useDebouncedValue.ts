import { useEffect, useState } from "react"

// `value` once it has held still for `delayMs`; the first value at once.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value)

	useEffect(() => {
		const timer = setTimeout(() => {
			setSettled(value)
		}, delayMs)

		return () => {
			clearTimeout(timer)
		}
	}, [value, delayMs])

	return settled
}
