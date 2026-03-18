import { useEffect } from "react"

export default function useEffectOnce(effect: React.EffectCallback) {
	// eslint-disable-next-line react-compiler/react-compiler
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(effect, [])
}
