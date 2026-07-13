package io.filen.authkey

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * App (JS) side of the auth.json DEK. Provisions/purges a 32-byte AES-256-GCM key, wrapped by a
 * non-exportable AndroidKeyStore key; the wrapped blob lives in filesDir.
 *
 * SHARED CONTRACT with io.filen.app.AuthKeystore (the Documents Provider, same UID): they are in
 * separate gradle modules so they can't share a class, but they MUST agree exactly — wrap-key alias
 * "filen_auth_dek_wrap", wrapped-DEK file "auth_dek.bin" in filesDir, format iv(12) || wrapped. This
 * module writes what the provider unwraps. Keep the two implementations in sync.
 */
class FilenAuthKeyModule : Module() {
	private val keystoreName = "AndroidKeyStore"
	private val wrapKeyAlias = "filen_auth_dek_wrap"
	private val wrappedDekFilename = "auth_dek.bin"
	private val dekSizeBytes = 32
	private val gcmIvSizeBytes = 12
	private val gcmTagBits = 128

	override fun definition() = ModuleDefinition {
		Name("FilenAuthKey")

		AsyncFunction("getOrCreateDek") {
			Base64.encodeToString(getOrCreateDek(), Base64.NO_WRAP)
		}

		AsyncFunction("purgeDek") {
			purge()
		}
	}

	private fun filesDir(): String {
		val context = appContext.reactContext ?: throw IllegalStateException("No React context available")

		return context.filesDir.absolutePath
	}

	private fun wrappedDekFile() = File(filesDir(), wrappedDekFilename)

	private fun getOrCreateWrapKey(): SecretKey {
		val keyStore = KeyStore.getInstance(keystoreName).apply { load(null) }
		(keyStore.getEntry(wrapKeyAlias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

		val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, keystoreName)
		generator.init(
			KeyGenParameterSpec.Builder(
				wrapKeyAlias,
				KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
			)
				.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
				.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
				.setKeySize(256)
				// No auth/unlock constraint: the provider reads the DEK headless (incl. screen-locked
				// post-first-unlock) with no UI to prompt.
				.build()
		)

		return generator.generateKey()
	}

	// Idempotent. Throws if no secure hardware is available so JS can fail closed (never a plaintext
	// or unprotected fallback).
	private fun getOrCreateDek(): ByteArray {
		loadDek()?.let { return it }

		val dek = ByteArray(dekSizeBytes).also { SecureRandom().nextBytes(it) }
		val cipher = Cipher.getInstance("AES/GCM/NoPadding")
		cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrapKey())
		val iv = cipher.iv
		val wrapped = cipher.doFinal(dek)
		wrappedDekFile().writeBytes(iv + wrapped)

		return dek
	}

	private fun loadDek(): ByteArray? {
		return try {
			val file = wrappedDekFile()
			if (!file.exists()) return null
			val bytes = file.readBytes()
			if (bytes.size <= gcmIvSizeBytes) return null

			val iv = bytes.copyOfRange(0, gcmIvSizeBytes)
			val wrapped = bytes.copyOfRange(gcmIvSizeBytes, bytes.size)

			val keyStore = KeyStore.getInstance(keystoreName).apply { load(null) }
			val entry = keyStore.getEntry(wrapKeyAlias, null) as? KeyStore.SecretKeyEntry ?: return null

			val cipher = Cipher.getInstance("AES/GCM/NoPadding")
			cipher.init(Cipher.DECRYPT_MODE, entry.secretKey, GCMParameterSpec(gcmTagBits, iv))
			cipher.doFinal(wrapped)
		} catch (e: Exception) {
			null
		}
	}

	private fun purge() {
		try {
			wrappedDekFile().delete()
		} catch (_: Exception) {
		}
		try {
			val keyStore = KeyStore.getInstance(keystoreName).apply { load(null) }
			if (keyStore.containsAlias(wrapKeyAlias)) {
				keyStore.deleteEntry(wrapKeyAlias)
			}
		} catch (_: Exception) {
		}
	}
}
