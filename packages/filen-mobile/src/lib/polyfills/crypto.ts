import QuickCrypto from "react-native-quick-crypto"

globalThis.crypto = {
	...globalThis.crypto,
	getRandomValues: QuickCrypto.getRandomValues as unknown as typeof globalThis.crypto.getRandomValues
}
