package com.r3v07v3r.mediahub

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowInsets
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher

/**
 * The whole app, as far as Android is concerned: one WebView showing the phone
 * and TV UI (src/app-ui), served by the app's own backend (Backend.kt).
 *
 * Also where the desktop's "Link a phone" QR code arrives: the camera opens
 * r3hub://pair?..., and this hands it to the page's pairing screen, which asks
 * before doing anything with it.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var status: TextView
    private var ready: Backend.State.Ready? = null
    private var pendingPair: String? = null

    private val onBackendState: (Backend.State) -> Unit = { next -> runOnUiThread { show(next) } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val background = Color.rgb(2, 6, 11)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // chrome://inspect on the PC, over USB. Debug builds only.
            WebView.setWebContentsDebuggingEnabled(true)
        }
        web = WebView(this).apply {
            setBackgroundColor(background)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
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
            setTextColor(Color.rgb(200, 214, 222))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            // Focusable so a TV remote can press "try again".
            isFocusable = true
            isClickable = true
            setOnClickListener { if (Backend.state is Backend.State.Failed) Backend.ensureStarted(this@MainActivity) }
        }
        val root = FrameLayout(this).apply {
            setBackgroundColor(background)
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(status, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        if (Build.VERSION.SDK_INT >= 30) {
            // Android 15+ draws every app edge to edge; keep the page's
            // bottom tabs clear of the gesture bar and its title clear of
            // the status bar and camera cut-out.
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

        takePairLink(intent)
        Backend.observe(onBackendState)
        Backend.ensureStarted(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takePairLink(intent)
        ready?.let { openPairing(it) }
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

    private fun takePairLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "r3hub" && data.host == "pair") pendingPair = data.toString()
    }

    private fun pairRoute(): String? = pendingPair?.let { "#/pair?link=" + Uri.encode(it) }

    private fun openPairing(state: Backend.State.Ready) {
        val route = pairRoute() ?: return
        pendingPair = null
        // A hash change: the page's router picks it up without a reload.
        web.loadUrl(state.origin + "/" + route)
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
                    val route = pairRoute().orEmpty()
                    pendingPair = null
                    web.loadUrl(Backend.entryUrl(state) + route)
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
}
