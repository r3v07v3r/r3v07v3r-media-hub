package com.r3v07v3r.mediahub

import android.content.Context
import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The app's backend: the desktop's own service layer (dist-headless/backend.cjs),
 * run by a real Node in a child process, reached by the page over loopback.
 * Same handlers, same database, same background jobs as the desktop — which is
 * the point: features land here without a second implementation.
 *
 * One per app process. It lives exactly as long as the process: the backend is
 * started with R3_STOP_ON_STDIN_CLOSE and this object holds its stdin open, so
 * when Android kills the app the pipe closes and Node shuts itself down cleanly
 * rather than being orphaned.
 *
 * How Node gets to run at all (Android only executes code from an app's native
 * library directory, and only files named lib*.so land there) is described in
 * scripts/android-node-payload.mjs, which stages what this starts.
 */
object Backend {
    private const val TAG = "R3Backend"
    /** Fixed, so the page's origin — and with it the WebView's storage and
     *  cookies — is the same on every launch. */
    const val PORT = 47310
    private const val READY = "[headless] ready "
    private const val START_TIMEOUT_MS = 60_000L

    sealed interface State {
        data object Starting : State
        data class Ready(val origin: String, val launchUrl: String) : State
        data class Failed(val message: String, val log: String) : State
    }

    @Volatile var state: State? = null
        private set
    private val listeners = CopyOnWriteArrayList<(State) -> Unit>()
    private val recent = ArrayDeque<String>()
    private var process: Process? = null
    /** Held, never written: closing it is how the backend is told to stop. */
    private var stdin: OutputStream? = null
    private var launchUsed = false

    fun observe(listener: (State) -> Unit) {
        listeners += listener
        state?.let(listener)
    }

    fun forget(listener: (State) -> Unit) {
        listeners -= listener
    }

    /** The URL a fresh page should open. The launch URL signs the WebView in
     *  and works once per backend run; after that the session cookie does. */
    @Synchronized
    fun entryUrl(ready: State.Ready): String {
        if (launchUsed) return ready.origin + "/"
        launchUsed = true
        return ready.launchUrl
    }

    @Synchronized
    fun ensureStarted(context: Context) {
        val current = state
        if (current is State.Starting || current is State.Ready) return
        val app = context.applicationContext
        publish(State.Starting)
        Thread({
            try {
                start(app)
            } catch (error: Throwable) {
                Log.e(TAG, "start failed", error)
                fail("Could not start: ${error.message}")
            }
        }, "r3-backend-start").start()
    }

    private fun start(context: Context) {
        val appDir = unpackAssets(context)
        val nativeDir = File(context.applicationInfo.nativeLibraryDir)
        val aliasDir = linkLibraryNames(context, nativeDir)

        val home = File(context.filesDir, "home").apply { mkdirs() }
        val tmp = File(context.cacheDir, "tmp").apply { mkdirs() }
        val userData = File(context.filesDir, "userdata").apply { mkdirs() }

        val builder = ProcessBuilder(File(nativeDir, "libnode.so").path, File(appDir, "backend.cjs").path)
            .directory(home)
            .redirectErrorStream(true)
        builder.environment().apply {
            // Aliases first: they are the names the binaries ask for.
            put("LD_LIBRARY_PATH", "${aliasDir.path}:${nativeDir.path}")
            // Termux's Node falls back to /data/data/com.termux/... for these
            // when they are unset, which is somebody else's sandbox.
            put("HOME", home.path)
            put("TMPDIR", tmp.path)
            put("R3_USER_DATA", userData.path)
            put("R3_SITE_DIR", File(appDir, "site").path)
            put("R3_BRIDGE_PORT", PORT.toString())
            put("R3_MASTER_KEY", MasterKey.get(context))
            put("R3_STOP_ON_STDIN_CLOSE", "1")
        }
        val started = builder.start()
        synchronized(this) {
            process = started
            stdin = started.outputStream
            launchUsed = false
        }

        Thread({ pump(started) }, "r3-backend-log").start()
        Thread({
            Thread.sleep(START_TIMEOUT_MS)
            if (state is State.Starting && process === started) {
                fail("The backend did not become ready within ${START_TIMEOUT_MS / 1000} s.")
                started.destroy()
            }
        }, "r3-backend-watchdog").apply { isDaemon = true }.start()
    }

    private fun pump(running: Process) {
        running.inputStream.bufferedReader().forEachLine { line ->
            Log.i(TAG, line)
            remember(line)
            if (line.startsWith(READY)) {
                val info = JSONObject(line.substring(READY.length))
                publish(State.Ready(info.getString("origin"), info.getString("launchUrl")))
            }
        }
        val code = running.waitFor()
        if (process === running) fail("The backend stopped (exit code $code).")
    }

    /**
     * Copies the backend and the page out of the APK, once per installed
     * version: assets cannot be executed or served in place, and copying on
     * every launch would cost seconds for nothing.
     */
    private fun unpackAssets(context: Context): File {
        val dir = File(context.filesDir, "app")
        val stampFile = File(context.filesDir, "app.stamp")
        @Suppress("DEPRECATION")
        val stamp = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (dir.isDirectory && stampFile.exists() && stampFile.readText() == stamp) return dir
        dir.deleteRecursively()
        copyAsset(context, "app", dir)
        stampFile.writeText(stamp)
        return dir
    }

    private fun copyAsset(context: Context, path: String, target: File) {
        val children = context.assets.list(path).orEmpty()
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            context.assets.open(path).use { input -> target.outputStream().use { input.copyTo(it) } }
            return
        }
        target.mkdirs()
        for (child in children) copyAsset(context, "$path/$child", File(target, child))
    }

    /**
     * The libraries ship as libr3_*.so; the binaries ask for libz.so.1,
     * libssl.so.3 and so on. A directory of symlinks under those names,
     * pointing into the native library directory, answers them. Rebuilt every
     * start: the native directory's path changes whenever the app is updated.
     */
    private fun linkLibraryNames(context: Context, nativeDir: File): File {
        val dir = File(context.filesDir, "nodelib")
        dir.deleteRecursively()
        dir.mkdirs()
        context.assets.open("node-libs.txt").bufferedReader().useLines { lines ->
            for (line in lines) {
                if (line.isBlank() || line.startsWith("#")) continue
                val (needed, shipped) = line.trim().split(" ", limit = 2)
                Os.symlink(File(nativeDir, shipped).path, File(dir, needed).path)
            }
        }
        return dir
    }

    @Synchronized
    private fun remember(line: String) {
        recent.addLast(line)
        while (recent.size > 40) recent.removeFirst()
    }

    @Synchronized
    private fun fail(message: String) {
        if (state is State.Failed) return
        publish(State.Failed(message, recent.joinToString("\n")))
    }

    private fun publish(next: State) {
        state = next
        for (listener in listeners) listener(next)
    }
}
