package io.filen.net

import android.content.Context
import android.util.Log

/**
 * Hands the JVM to the certificate verifier compiled into the sdk-rs library, which asks the
 * platform's X509TrustManager through JNI (no online revocation check). Until it runs, every SDK
 * connection fails closed. The entry point still takes a Context; the SDK no longer reads it.
 *
 * The JNI symbol is Java_io_filen_net_FilenTls_nativeInit, exported by libfilen_sdk_rs.so: the Rust
 * cdylib that @filen/sdk-rs ships in its jniLibs and its TurboModule (libfilen-sdk-rs.so) links
 * against. JNI resolves natives only in libraries loaded through System.loadLibrary, so the Rust
 * library is loaded here by name; the dynamic linker returns the copy already mapped, if any.
 */
object FilenTls {
	private const val TAG = "FilenTls"
	private const val SDK_LIBRARY = "filen_sdk_rs"

	@Volatile
	private var initialized = false

	@JvmStatic
	external fun nativeInit(context: Context): Boolean

	val isInitialized: Boolean
		get() = initialized

	/** Idempotent; a failed attempt is retried on the next call. */
	@Synchronized
	fun ensureInitialized(context: Context): Boolean {
		if (initialized) {
			return true
		}

		initialized =
			try {
				System.loadLibrary(SDK_LIBRARY)
				nativeInit(context.applicationContext)
			} catch (e: UnsatisfiedLinkError) {
				// An sdk-rs build without the entry point: the SDK reports it through tlsStatus().
				Log.e(TAG, "TLS verifier init unavailable", e)
				false
			}

		if (!initialized) {
			Log.e(TAG, "TLS verifier init failed")
		}

		return initialized
	}
}
