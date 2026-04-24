import QuickCrypto from "react-native-quick-crypto"

globalThis.crypto = {
	...globalThis.crypto,
	// This is fine
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getRandomValues: QuickCrypto.getRandomValues as unknown as any
}
