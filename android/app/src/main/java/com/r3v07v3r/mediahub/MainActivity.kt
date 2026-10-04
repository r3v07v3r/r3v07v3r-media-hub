package com.r3v07v3r.mediahub

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject

/**
 * The whole app, as far as Android is concerned: one WebView showing the phone
 * and TV UI (src/app-ui), served by the app's own backend (Backend.kt), over a
 * SurfaceView the player draws on (PlayerHost.kt). The page is opaque except
 * on its player screen, which is transparent so the video shows through.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var root: FrameLayout
    private var ready: Backend.State.Ready? = null
    private val main = Handler(Looper.getMainLooper())

    private val onBackendState: (Backend.State) -> Unit = { next -> runOnUiThread { show(next) } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val background = Color.rgb(2, 6, 11)
        val player = player(this)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // chrome://inspect on the PC, over USB. Debug builds only.
            WebView.setWebContentsDebuggingEnabled(true)
        }
        // Bottom of the stack: the video. It punches through the window, so
        // everything above it must be transparent wherever video should show.
        val surface = SurfaceView(this).apply { holder.addCallback(player) }
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            addJavascriptInterface(NativeBridge(), "R3Android")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.host == "127.0.0.1") return false
                    // Anything else (a TorBox or Trakt page, a sign-in) belongs
                    // in the browser, not inside the app.
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (_: ActivityNotFoundException) {
                    }
                    return true
                }
            }
            visibility = View.INVISIBLE
        }
        status = TextView(this).apply {
            setBackgroundColor(background)
            setTextColor(Color.rgb(200, 214, 222))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            // Focusable so a TV remote can press "try again".
            isFocusable = true
            isClickable = true
            setOnClickListener { if (Backend.state is Backend.State.Failed) Backend.ensureStarted(this@MainActivity) }
        }
        root = FrameLayout(this).apply {
            setBackgroundColor(background)
            addView(surface, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(status, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        if (Build.VERSION.SDK_INT >= 30) {
            // Android 15+ draws every app edge to edge; keep the page clear of
            // the status bar, the gesture bar and the camera cut-out.
            root.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
                goBack()
            }
        }

        // The backend asks for the player on its output; PlayerHost is main-thread only.
        Backend.onHostRequest = { request ->
            main.post {
                when (request.optString("type")) {
                    "mpv-start" -> {
                        val args = request.optJSONArray("args")
                        player.start(List(args?.length() ?: 0) { args!!.getString(it) })
                    }
                    "mpv-stop" -> player.stop()
                }
            }
        }
        Backend.observe(onBackendState)
        Backend.ensureStarted(this)
        if (savedInstanceState == null) checkForUpdate()
    }

    override fun onResume() {
        super.onResume()
        // Coming back to the app is when the page asks the backend what was
        // watched elsewhere (src/app-ui/lib/librarySync.ts). Android promises
        // nothing about the page's own visibilitychange on a resume, so the app
        // says so itself. Before the page has loaded there is nobody to tell.
        if (ready != null) web.evaluateJavascript("window.dispatchEvent(new Event('r3-resume'))", null)
    }

    @Deprecated("Below Android 13 only; newer versions use the callback above.")
    override fun onBackPressed() {
        goBack()
    }

    private fun goBack() {
        if (web.canGoBack()) web.goBack() else finish()
    }

    override fun onDestroy() {
        Backend.forget(onBackendState)
        web.destroy()
        super.onDestroy()
    }

    private fun show(state: Backend.State) {
        when (state) {
            is Backend.State.Starting -> {
                status.visibility = View.VISIBLE
                status.text = "Starting R3 Media Hub…"
            }
            is Backend.State.Ready -> {
                if (ready == null) {
                    ready = state
                    web.loadUrl(Backend.entryUrl(state))
                }
                status.visibility = View.GONE
                web.visibility = View.VISIBLE
                web.requestFocus()
            }
            is Backend.State.Failed -> {
                ready = null
                web.visibility = View.INVISIBLE
                status.visibility = View.VISIBLE
                status.text = "R3 Media Hub could not start.\n\n${state.message}\n\nTap to try again.\n\n${state.log.takeLast(1200)}"
                status.gravity = Gravity.START or Gravity.CENTER_VERTICAL
                status.requestFocus()
            }
        }
    }

    /** Full screen and awake while the page shows its player; normal otherwise. */
    private fun setPlayerMode(active: Boolean) {
        if (active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 30) {
            val controller = window.insetsController ?: return
            if (active) {
                controller.hide(WindowInsets.Type.systemBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller.show(WindowInsets.Type.systemBars())
            }
        }
    }

    // ------------------------------------------------------------ pairing scan

    /**
     * Google's code scanner: the camera UI is the system's, the app needs no
     * camera permission, and the scanned text comes back to this app only —
     * which is the point, since the desktop's pairing code carries a key
     * (see src/main/media-hub/devicePairingCore.ts's PAIRING_PREFIX).
     */
    private fun scanPairingCode() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { code -> deliverScan(code.rawValue, null) }
            .addOnCanceledListener { deliverScan(null, null) }
            .addOnFailureListener { error ->
                deliverScan(null, "The scanner is not available on this device (${error.message}). Paste the code instead.")
            }
    }

    private fun deliverScan(text: String?, error: String?) {
        val detail = JSONObject().put("text", text ?: JSONObject.NULL)
        if (error != null) detail.put("error", error)
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('r3-scan', { detail: $detail }))", null)
    }

    /** What the page may ask of the app (src/app-ui/lib/nativeHost.ts). Called
     *  on a WebView thread; everything is moved to the main thread. */
    inner class NativeBridge {
        @JavascriptInterface
        fun scanPairingCode() {
            main.post { this@MainActivity.scanPairingCode() }
        }

        @JavascriptInterface
        fun setPlayerActive(active: Boolean) {
            main.post { setPlayerMode(active) }
        }
    }

    // ----------------------------------------------------------------- updates

    private fun checkForUpdate() {
        if (updateChecked) return
        updateChecked = true
        Thread({
            val release = Updater.findUpdate(applicationContext) ?: return@Thread
            main.post { offerUpdate(release) }
        }, "r3-update-check").start()
    }

    private fun offerUpdate(release: Updater.Release) {
        if (isFinishing || isDestroyed) return
        val installed = packageManager.getPackageInfo(packageName, 0).versionName
        AlertDialog.Builder(this)
            .setTitle("Update available")
            .setMessage("R3 Media Hub ${release.version} is out. This phone has $installed.")
            .setPositiveButton("Update") { _, _ -> installUpdate(release) }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun installUpdate(release: Updater.Release) {
        val progress = AlertDialog.Builder(this)
            .setTitle("Updating")
            .setMessage("Downloading ${release.version}…")
            .setCancelable(false)
            .show()
        Thread({
            try {
                Updater.downloadAndInstall(applicationContext, release) { percent ->
                    main.post { progress.setMessage("Downloading ${release.version}… $percent%") }
                }
                main.post { progress.dismiss() }
            } catch (error: Exception) {
                main.post {
                    progress.dismiss()
                    AlertDialog.Builder(this)
                        .setTitle("Update failed")
                        .setMessage(error.message ?: "The update could not be installed.")
                        .setPositiveButton("OK", null)
                        .show()
                }
            }
        }, "r3-update-install").start()
    }

    companion object {
        /** One check per app process, not per screen rotation or re-open. */
        private var updateChecked = false
        private var playerHost: PlayerHost? = null

        /** One player per process: it outlives the activity (a rotation, a
         *  trip to the scanner) the way the backend does. */
        fun player(activity: Activity): PlayerHost =
            playerHost ?: PlayerHost(activity.applicationContext).also { playerHost = it }
    }
}
