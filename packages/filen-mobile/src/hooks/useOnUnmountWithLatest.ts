import { useEffect, useRef } from "react"

/**
 * Calls `onUnmount` with the latest `value` when the component unmounts, and never before.
 *
 * Depending on `value` directly would re-run the cleanup whenever its identity changes (picker
 * select options are deserialized fresh on every render), firing unmount-only work such as a
 * `cancelled: true` emit mid-session and silently aborting the selection flow.
 */
export default function useOnUnmountWithLatest<T>(value: T, onUnmount: (latest: T) => void): void {
	const valueRef = useRef(value)
	const onUnmountRef = useRef(onUnmount)

	useEffect(() => {
		valueRef.current = value
		onUnmountRef.current = onUnmount
	})

	useEffect(() => {
		return () => {
			onUnmountRef.current(valueRef.current)
		}
	}, [])
}
