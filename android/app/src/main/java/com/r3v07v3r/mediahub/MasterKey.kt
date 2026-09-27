package com.r3v07v3r.mediahub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The key the backend seals every stored credential with (R3_MASTER_KEY; see
 * src/headless/electronShim's safeStorage). It is the Android counterpart of
 * the desktop's OS keychain:
 *
 * 32 random bytes, generated once, stored only WRAPPED by an AES key that
 * lives in the Android Keystore (hardware-backed where the device has it) and
 * cannot be exported. The plain key exists only in memory and in the
 * backend's environment, never on disk — so a copy of the app's files alone
 * opens nothing.
 */
object MasterKey {
    private const val ALIAS = "r3-master-wrap"
    private const val PREFS = "r3-master"
    private const val WRAPPED = "wrapped"

    fun get(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val stored = prefs.getString(WRAPPED, null)
        if (stored != null) return Base64.encodeToString(unwrap(stored), Base64.NO_WRAP)

        val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        // commit(), not apply(): the backend starts sealing with this key
        // moments from now, and a key that never reached disk is every
        // credential lost on the next launch.
        check(prefs.edit().putString(WRAPPED, wrap(key)).commit()) { "Could not save the storage key." }
        return Base64.encodeToString(key, Base64.NO_WRAP)
    }

    private fun wrappingKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun wrap(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val sealed = cipher.iv + cipher.doFinal(plain)
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    private fun unwrap(stored: String): ByteArray {
        val sealed = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, sealed, 0, 12))
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }
}
