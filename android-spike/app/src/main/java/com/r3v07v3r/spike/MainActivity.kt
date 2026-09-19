package com.r3v07v3r.spike

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import dev.jdtech.mpv.MPVLib
import java.io.File

/**
 * A measurement tool, not a product. It answers, on the real TV box, the
 * questions the TV app's design rests on:
 *
 *  - does libmpv play an HTTPS MKV with styled ASS subtitles cleanly here, and
 *    with which vo / hwdec pairing (extras `vo`, `hwdec`);
 *  - does a transparent WebView composite over that video, and stay responsive
 *    to the D-pad while it plays;
 *  - how does the REAL renderer bundle behave in this box's WebView (extra
 *    `url`, pointed at the headless backend on the dev PC), measured rather
 *    than felt (extra `perf=1` runs assets/perf-probe.js in the loaded page);
 *  - does mpv's own JSON IPC socket work inside the app sandbox (extra `ipc=1`)
 *    — if it does, the desktop's mpv client connects to it nearly unchanged.
 *
 * Everything is driven by intent extras so a run is one adb command, and every
 * result goes to logcat under the tag R3Spike as well as the on-screen HUD.
 *
 *   adb shell am start -n com.r3v07v3r.spike/.MainActivity \
 *       --es video "https://…/sample.mkv" --es vo gpu-next --es hwdec mediacodec --es ipc 1
 */
class MainActivity : Activity(), SurfaceHolder.Callback, MPVLib.EventObserver, MPVLib.LogObserver {

    private lateinit var surface: SurfaceView
    private lateinit var web: WebView
    private lateinit var hud: TextView
    private val main = Handler(Looper.getMainLooper())

    private var mpv: MPVLib? = null
    private var vo = "gpu-next"
    private var pendingVideo: String? = null
    private val facts = LinkedHashMap<String, String>()
    private var perfLine = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Order is z-order: video at the bottom, the page over it, the HUD on top.
        surface = SurfaceView(this)
        web = WebView(this)
        hud = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(150, 0, 0, 0))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(12, 8, 12, 8)
            isFocusable = false
        }
        val root = FrameLayout(this)
        root.addView(surface, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(hud, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.END))
        setContentView(root)

        surface.holder.addCallback(this)
        setUpWebView()
        describeDevice()
        launch(intent)

        main.post(object : Runnable {
            override fun run() {
                sampleMemory()
                drawHud()
                main.postDelayed(this, 2000)
            }
        })
    }

    /** singleTask: a second `am start` re-runs with new extras instead of stacking. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        launch(intent)
    }

    private fun launch(intent: Intent) {
        val extras = intent.extras
        val page = extras?.getString("url") ?: "file:///android_asset/overlay-test.html"
        val video = extras?.getString("video")
        vo = extras?.getString("vo") ?: "gpu-next"
        val hwdec = extras?.getString("hwdec") ?: "mediacodec"
        val ao = extras?.getString("ao") ?: "audiotrack"
        val wantIpc = extras?.getString("ipc") == "1"
        val wantPerf = extras?.getString("perf") == "1"
        val lite = extras?.getString("lite") == "1"
        val perfDelayMs = (extras?.getString("perfDelay")?.toLongOrNull() ?: 12L) * 1000L
        Log.i(TAG, "run page=$page video=$video vo=$vo hwdec=$hwdec ao=$ao ipc=$wantIpc perf=$wantPerf lite=$lite")

        facts["page"] = page.take(60)
        facts["asked"] = "vo=$vo hwdec=$hwdec ao=$ao"
        perfLine = ""

        startMpv(hwdec, ao, wantIpc)
        if (video != null) play(video)

        web.loadUrl(page)
        if (wantPerf || lite) {
            main.postDelayed({
                if (lite) inject("lite.js")
                if (wantPerf) inject("perf-probe.js")
            }, perfDelayMs)
        }
    }

    // ------------------------------------------------------------------ mpv

    private fun startMpv(hwdec: String, ao: String, wantIpc: Boolean) {
        stopMpv()
        val mpvConfigDir = File(filesDir, "mpv").apply { mkdirs() }
        val mpvCacheDir = File(cacheDir, "mpv").apply { mkdirs() }
        writeFontsConf(mpvConfigDir)
        val socket = File(filesDir, "mpv.sock").apply { delete() }

        val lib = MPVLib.create(this) ?: run {
            facts["mpv"] = "MPVLib.create() returned null"
            Log.e(TAG, "MPVLib.create() returned null")
            return
        }
        // Findroid's sequence, with the buffer sizes a 2 GB box can afford.
        lib.setOptionString("config", "yes")
        lib.setOptionString("config-dir", mpvConfigDir.path)
        lib.setOptionString("gpu-shader-cache-dir", mpvCacheDir.path)
        lib.setOptionString("icc-cache-dir", mpvCacheDir.path)
        lib.setOptionString("profile", "fast")
        lib.setOptionString("vo", vo)
        lib.setOptionString("ao", ao)
        lib.setOptionString("gpu-context", "android")
        lib.setOptionString("opengl-es", "yes")
        lib.setOptionString("hwdec", hwdec)
        lib.setOptionString("hwdec-codecs", "h264,hevc,mpeg4,mpeg2video,vp8,vp9,av1")
        lib.setOptionString("cache", "yes")
        lib.setOptionString("demuxer-max-bytes", "64MiB")
        lib.setOptionString("demuxer-max-back-bytes", "16MiB")
        lib.setOptionString("force-window", "no")
        lib.setOptionString("keep-open", "yes")
        lib.setOptionString("idle", "yes")
        lib.setOptionString("ytdl", "no")
        lib.setOptionString("osc", "no")
        lib.setOptionString("input-default-bindings", "no")
        lib.setOptionString("sub-auto", "no")
        lib.setOptionString("msg-level", "all=warn")
        if (wantIpc) lib.setOptionString("input-ipc-server", socket.path)

        lib.init()
        lib.addObserver(this)
        lib.addLogObserver(this)
        lib.observeProperty("hwdec-current", MPVLib.MpvFormat.MPV_FORMAT_STRING)
        lib.observeProperty("video-codec", MPVLib.MpvFormat.MPV_FORMAT_STRING)
        lib.observeProperty("current-vo", MPVLib.MpvFormat.MPV_FORMAT_STRING)
        lib.observeProperty("video-params/w", MPVLib.MpvFormat.MPV_FORMAT_INT64)
        lib.observeProperty("video-params/h", MPVLib.MpvFormat.MPV_FORMAT_INT64)
        lib.observeProperty("frame-drop-count", MPVLib.MpvFormat.MPV_FORMAT_INT64)
        lib.observeProperty("decoder-frame-drop-count", MPVLib.MpvFormat.MPV_FORMAT_INT64)
        lib.observeProperty("estimated-vf-fps", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
        lib.observeProperty("demuxer-cache-duration", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
        lib.observeProperty("paused-for-cache", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
        lib.observeProperty("sid", MPVLib.MpvFormat.MPV_FORMAT_STRING)
        mpv = lib

        facts["mpv"] = lib.getPropertyString("mpv-version") ?: "?"
        Log.i(TAG, "mpv up: ${facts["mpv"]}")

        // The surface may already exist (a re-run): attach now rather than wait
        // for a callback that will not come again.
        if (surface.holder.surface?.isValid == true) attach(surface.holder)

        if (wantIpc) main.postDelayed({ probeIpc(socket) }, 1500)
    }

    private fun play(url: String) {
        val lib = mpv ?: return
        if (surface.holder.surface?.isValid != true) {
            pendingVideo = url // surfaceCreated will start it
            return
        }
        lib.command(arrayOf("loadfile", url))
        Log.i(TAG, "loadfile $url")
    }

    private fun stopMpv() {
        val lib = mpv ?: return
        mpv = null
        try {
            lib.removeObserver(this)
            lib.removeLogObserver(this)
            lib.setOptionString("vo", "null")
            lib.setOptionString("force-window", "no")
            lib.detachSurface()
            lib.destroy()
        } catch (error: Throwable) {
            Log.w(TAG, "stopMpv: $error")
        }
    }

    private fun attach(holder: SurfaceHolder) {
        val lib = mpv ?: return
        lib.attachSurface(holder.surface)
        lib.setOptionString("force-window", "yes")
        lib.setOptionString("vo", vo)
        val frame = holder.surfaceFrame
        lib.setPropertyString("android-surface-size", "${frame.width()}x${frame.height()}")
        pendingVideo?.let {
            pendingVideo = null
            play(it)
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) = attach(holder)

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        mpv?.setPropertyString("android-surface-size", "${width}x$height")
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        val lib = mpv ?: return
        lib.setOptionString("vo", "null")
        lib.setOptionString("force-window", "no")
        lib.detachSurface()
    }

    /**
     * THE question for reusing the desktop's mpv client: is mpv's own JSON IPC
     * server reachable from inside the app sandbox? It is compiled in (POSIX
     * builds always have it); whether the socket can be created and connected
     * to under Android's SELinux policy is what nobody has written down.
     */
    private fun probeIpc(socket: File) {
        Thread {
            val verdict = try {
                if (!socket.exists()) {
                    "NO SOCKET FILE at ${socket.path}"
                } else {
                    LocalSocket().use { client ->
                        client.connect(LocalSocketAddress(socket.path, LocalSocketAddress.Namespace.FILESYSTEM))
                        client.soTimeout = 3000
                        client.outputStream.write("{\"command\":[\"get_property\",\"mpv-version\"],\"request_id\":7}\n".toByteArray())
                        client.outputStream.flush()
                        val reply = client.inputStream.bufferedReader().readLine()
                        "OK reply=$reply"
                    }
                }
            } catch (error: Throwable) {
                "FAILED ${error.javaClass.simpleName}: ${error.message}"
            }
            Log.i(TAG, "ipc-server: $verdict")
            main.post { facts["ipc"] = verdict.take(70) }
        }.start()
    }

    /** mpv's libass needs fontconfig pointed at the system fonts; nothing is bundled. */
    private fun writeFontsConf(configDir: File) {
        File(configDir, "fonts.conf").writeText(
            """
            <?xml version="1.0"?>
            <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
            <fontconfig>
              <dir>/system/fonts/</dir>
              <dir>/product/fonts/</dir>
              <cachedir>${File(cacheDir, "fontconfig").path}</cachedir>
            </fontconfig>
            """.trimIndent()
        )
    }

    // ------------------------------------------------- mpv observer callbacks
    // (called on mpv's own thread)

    override fun eventProperty(property: String) {}
    override fun eventProperty(property: String, value: Long) = note(property, value.toString())
    override fun eventProperty(property: String, value: Boolean) = note(property, value.toString())
    override fun eventProperty(property: String, value: String) = note(property, value)
    override fun eventProperty(property: String, value: Double) =
        note(property, String.format("%.2f", value))

    override fun event(eventId: Int) {
        when (eventId) {
            MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> Log.i(TAG, "mpv: file loaded")
            MPVLib.MpvEvent.MPV_EVENT_END_FILE -> Log.i(TAG, "mpv: end of file")
            MPVLib.MpvEvent.MPV_EVENT_VIDEO_RECONFIG -> Log.i(TAG, "mpv: video reconfig")
        }
    }

    override fun logMessage(prefix: String, level: Int, text: String) {
        if (level <= MPVLib.MpvLogLevel.MPV_LOG_LEVEL_WARN) Log.w(TAG, "mpv[$prefix] ${text.trim()}")
    }

    private fun note(property: String, value: String) {
        main.post {
            if (facts[property] != value) {
                // Drop counts and cache seconds change constantly; the log keeps
                // only what is a fact about the run.
                val noisy = property.contains("drop") || property.contains("cache") || property == "estimated-vf-fps"
                if (!noisy) Log.i(TAG, "mpv $property=$value")
                facts[property] = value
            }
        }
    }

    // -------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over adb
        web.setBackgroundColor(Color.TRANSPARENT)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // The design canvas is 1920 wide; a TV's WebView otherwise reports
            // 960 CSS px and gets the tablet layout.
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val text = message.message()
                if (text.startsWith("[r3-perf]")) {
                    Log.i(TAG, text)
                    perfLine = text.removePrefix("[r3-perf]").trim().take(110)
                } else if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.w(TAG, "page error: $text")
                }
                return true
            }
        }
        web.requestFocus()
    }

    private fun inject(asset: String) {
        val script = assets.open(asset).bufferedReader().use { it.readText() }
        web.evaluateJavascript(script, null)
        Log.i(TAG, "injected $asset")
    }

    // ------------------------------------------------------------------ HUD

    private fun describeDevice() {
        val memory = ActivityManager.MemoryInfo()
        (getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
        val webView = WebView.getCurrentWebViewPackage()
        val device = "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
        val abis = Build.SUPPORTED_ABIS.joinToString(",")
        val ram = "${memory.totalMem / (1024 * 1024)} MB"
        val wv = "${webView?.packageName} ${webView?.versionName}"
        facts["device"] = device
        facts["abis"] = abis
        facts["ram"] = ram
        facts["webview"] = wv
        Log.i(TAG, "device=$device abis=$abis ram=$ram webview=$wv")
    }

    private fun sampleMemory() {
        // This process only — mpv and the WebView's browser side. The sandboxed
        // renderer is a separate process: `adb shell dumpsys meminfo <package>`
        // is the whole picture.
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        facts["pss(app proc)"] = "${info.totalPss / 1024} MB"
    }

    private fun drawHud() {
        val lines = facts.entries.map { (key, value) -> "$key: $value" }.toMutableList()
        if (perfLine.isNotEmpty()) lines += "perf: $perfLine"
        hud.text = lines.joinToString("\n")
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        stopMpv()
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "R3Spike"
    }
}
