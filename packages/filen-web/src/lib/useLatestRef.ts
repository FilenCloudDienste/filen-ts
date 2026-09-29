import { useEffect, useRef, type RefObject } from "react"

// The latest committed value, for listeners, timers and async continuations that outlive the render
// that bound them. Synced after commit because refs must not be written during render; those readers
// only ever run after one.
export function useLatestRef<T>(value: T): RefObject<T> {
	const ref = useRef(value)

	useEffect(() => {
		ref.current = value
	}, [value])

	return ref
}
