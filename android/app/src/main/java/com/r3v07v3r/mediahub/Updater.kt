package com.r3v07v3r.mediahub

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Keeps the app on the latest release, checked on every launch.
 *
 * Releases are the desktop app's own GitHub releases: every preview and every
 * stable release carries `r3-media-hub-android.apk`, built at that version
 * (.github/workflows/build-and-release.yml). The phone follows the same
 * channel as the desktop it was linked to; before it is linked, preview —
 * the app is in its preview phase and there is no stable APK yet.
 *
 * Android never lets an app replace itself silently: the last step is always
 * the system's own "Update this app?" confirmation. And it only accepts an
 * update signed with the same key as what is installed, so a download that
 * is not ours is refused by the system as well as by the checks below.
 */
object Updater {
    private const val TAG = "R3Updater"
    private const val RELEASES = "https://api.github.com/repos/r3v07v3r/r3v07v3r-media-hub/releases?per_page=30"
    private const val ASSET = "r3-media-hub-android.apk"
    private const val ACTION_STATUS = "com.r3v07v3r.mediahub.INSTALL_STATUS"

    /** Test builds were signed with the committed debug key; releases are
     *  signed with a key kept out of the repository. Android will not put one
     *  over the other, and only the person can remove the old build. */
    private const val DIFFERENT_KEY = "This update is signed with a different key from the R3 Media Hub " +
        "on this phone, so Android will not install it over this one. To move to it, uninstall " +
        "R3 Media Hub once (this removes its settings and sign-ins from this phone), then install " +
        "r3-media-hub-android.apk from the latest release."

    data class Release(val version: String, val code: Long, val url: String, val bytes: Long)

    /** The same rule as build.gradle.kts's versionCodeOf — they must agree. */
    fun versionCodeOf(name: String): Long {
        val match = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?""").find(name) ?: return 1
        val (major, minor, patch, preview) = match.destructured
        val base = (major.toLong() * 100 + minor.toLong()) * 1000 + patch.toLong()
        val step = if (preview.isEmpty()) 9999 else minOf(preview.toLong(), 9998)
        return base * 10000 + step
    }

    fun installedCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }

    /** 'stable' only when the linked desktop said so; see the class note. */
    private fun channel(context: Context): String {
        val file = File(context.filesDir, "userdata/media-hub-settings.json")
        return try {
            if (JSONObject(file.readText()).optString("updateChannel") == "stable") "stable" else "preview"
        } catch (_: Exception) {
            "preview"
        }
    }

    /** The newest release on this device's channel that is newer than what is
     *  installed, or null. Network failures are null too: a phone offline at
     *  launch just starts, and checks again next time. Blocking; call off the
     *  main thread. */
    fun findUpdate(context: Context): Release? {
        return try {
            val stableOnly = channel(context) == "stable"
            val installed = installedCode(context)
            val releases = JSONArray(get(RELEASES))
            var best: Release? = null
            for (i in 0 until releases.length()) {
                val release = releases.getJSONObject(i)
                if (release.optBoolean("draft")) continue
                if (stableOnly && release.optBoolean("prerelease")) continue
                val version = release.optString("tag_name").removePrefix("v")
                val assets = release.optJSONArray("assets") ?: continue
                for (j in 0 until assets.length()) {
                    val asset = assets.getJSONObject(j)
                    if (asset.optString("name") != ASSET) continue
                    val candidate = Release(
                        version,
                        versionCodeOf(version),
                        asset.getString("browser_download_url"),
                        asset.optLong("size")
                    )
                    if (candidate.code > installed && (best == null || candidate.code > best.code)) best = candidate
                }
            }
            best
        } catch (error: Exception) {
            Log.w(TAG, "update check failed", error)
            null
        }
    }

    private fun get(url: String): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 15_000
        connection.setRequestProperty("Accept", "application/vnd.github+json")
        connection.setRequestProperty("User-Agent", "r3-media-hub-android")
        try {
            if (connection.responseCode != 200) error("HTTP ${connection.responseCode} from $url")
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /** Downloads the APK, checks it is this app and newer, and hands it to
     *  the system installer, which asks the person to confirm. */
    fun downloadAndInstall(context: Context, release: Release, onProgress: (Int) -> Unit) {
        val file = File(context.cacheDir, "update.apk")
        val connection = URL(release.url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = true
        try {
            if (connection.responseCode != 200) error("Download failed (HTTP ${connection.responseCode}).")
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: release.bytes
            connection.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var done = 0L
                    var lastPercent = -1
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        done += read
                        val percent = if (total > 0) (done * 100 / total).toInt() else 0
                        if (percent != lastPercent) {
                            lastPercent = percent
                            onProgress(percent)
                        }
                    }
                }
            }
        } finally {
            connection.disconnect()
        }

        @Suppress("DEPRECATION")
        val archive = context.packageManager.getPackageArchiveInfo(file.path, 0)
            ?: error("The download is not an app.")
        if (archive.packageName != context.packageName) error("The download is a different app.")
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        if (code <= installedCode(context)) error("The download is not newer than this version.")
        if (signedWithDifferentKey(context, file)) error(DIFFERENT_KEY)

        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            file.inputStream().use { input ->
                session.openWrite("base.apk", 0, file.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            val intent = Intent(ACTION_STATUS).setPackage(context.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender)
        }
    }

    /** True only when both signers could be read and share no certificate
     *  (a rotated key keeps the old one in its history, so it still counts as
     *  the same). If either cannot be read, the install goes ahead and the
     *  system's own check, reported by StatusReceiver, has the last word. */
    @Suppress("DEPRECATION") // the Int-flag lookups; still the only ones below API 33
    private fun signedWithDifferentKey(context: Context, file: File): Boolean {
        return try {
            val pm = context.packageManager
            val (installed, download) = if (Build.VERSION.SDK_INT >= 28) {
                val flags = PackageManager.GET_SIGNING_CERTIFICATES
                signers(pm.getPackageInfo(context.packageName, flags)) to
                    signers(pm.getPackageArchiveInfo(file.path, flags))
            } else {
                val flags = PackageManager.GET_SIGNATURES
                oldSigners(pm.getPackageInfo(context.packageName, flags)) to
                    oldSigners(pm.getPackageArchiveInfo(file.path, flags))
            }
            installed.isNotEmpty() && download.isNotEmpty() && installed.intersect(download).isEmpty()
        } catch (error: Exception) {
            Log.w(TAG, "could not compare signing keys", error)
            false
        }
    }

    @Suppress("DEPRECATION") // PackageInfo.signatures, the only record below API 28
    private fun oldSigners(info: PackageInfo?): Set<String> =
        info?.signatures?.map { it.toCharsString() }?.toSet().orEmpty()

    private fun signers(info: PackageInfo?): Set<String> {
        if (Build.VERSION.SDK_INT < 28) return emptySet()
        val signing = info?.signingInfo ?: return emptySet()
        val certificates = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        return certificates?.map { it.toCharsString() }?.toSet().orEmpty()
    }

    /** The installer reports here. "Pending user action" carries the system's
     *  confirmation screen, which has to be started by us. A refusal over the
     *  signing key (normally caught before the download is handed over, see
     *  signedWithDifferentKey) is told to the person, not just logged. */
    class StatusReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                PackageInstaller.STATUS_SUCCESS -> Log.i(TAG, "update installed")
                PackageInstaller.STATUS_FAILURE_CONFLICT -> {
                    Log.w(TAG, "update not installed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                    Toast.makeText(context.applicationContext, DIFFERENT_KEY, Toast.LENGTH_LONG).show()
                }
                else -> Log.w(TAG, "update not installed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
            }
        }
    }
}
