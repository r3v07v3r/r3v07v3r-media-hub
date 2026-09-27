package com.r3v07v3r.mediahub

import android.content.Context
import android.util.Log
import android.view.SurfaceHolder
import dev.jdtech.mpv.MPVLib
import java.io.File

/**
 * The video: libmpv, drawing on a SurfaceView UNDER the WebView, started and
 * stopped when the backend asks (src/main/media-hub/hostPlayer.ts).
 *
 * The backend passes the same arguments it gives the mpv binary on the
 * desktop, including --input-ipc-server, and then drives this player over
 * that socket exactly as it drives the desktop's — commands, observed
 * properties, track lists and all. (That libmpv serves the IPC socket inside
 * an app sandbox was the Android spike's key finding.) This class only
 * translates the launch: argument list in, options set, Android's own video
 * and audio outputs swapped in for the desktop's.
 *
 * Main thread only.
 */
class PlayerHost(private val context: Context) : SurfaceHolder.Callback {
    private var mpv: MPVLib? = null
    private var holder: SurfaceHolder? = null

    /** Desktop options that mean nothing here, or that are Android's to decide. */
    private val skipped = setOf(
        "wid", "input-vo-keyboard", "focus-on", "window-dragging", "hwdec",
        "force-window", "config", "demuxer-max-bytes", "demuxer-max-back-bytes"
    )

    fun start(args: List<String>) {
        stop()
        val lib = MPVLib.create(context) ?: run {
            Log.e(TAG, "MPVLib.create() returned null")
            return
        }
        val configDir = File(context.filesDir, "mpv").apply { mkdirs() }
        val cacheDir = File(context.cacheDir, "mpv").apply { mkdirs() }
        writeFontsConf(configDir)

        for (arg in args) {
            if (!arg.startsWith("--")) continue
            val body = arg.removePrefix("--")
            val eq = body.indexOf('=')
            val (name, value) = when {
                eq >= 0 -> body.substring(0, eq) to body.substring(eq + 1)
                body.startsWith("no-") -> body.removePrefix("no-") to "no"
                else -> body to "yes"
            }
            if (name in skipped) continue
            lib.setOptionString(name, value)
        }
        // Android's outputs, as proven in the spike (HEVC 1080p, no drops).
        // config=yes only so libass finds fonts.conf; the directory holds
        // nothing else, so the desktop's --no-config guarantee still holds.
        lib.setOptionString("config", "yes")
        lib.setOptionString("config-dir", configDir.path)
        lib.setOptionString("gpu-shader-cache-dir", cacheDir.path)
        lib.setOptionString("icc-cache-dir", cacheDir.path)
        lib.setOptionString("vo", "gpu-next")
        lib.setOptionString("gpu-context", "android")
        lib.setOptionString("opengl-es", "yes")
        lib.setOptionString("ao", "audiotrack")
        lib.setOptionString("hwdec", "mediacodec")
        lib.setOptionString("hwdec-codecs", "h264,hevc,mpeg4,mpeg2video,vp8,vp9,av1")
        // A phone or a budget TV box, not a desktop: read-ahead in bytes is
        // capped whatever buffer preset the desktop setting asked for.
        lib.setOptionString("demuxer-max-bytes", "128MiB")
        lib.setOptionString("demuxer-max-back-bytes", "32MiB")
        lib.setOptionString("force-window", "no")
        lib.init()
        mpv = lib
        Log.i(TAG, "mpv up: ${lib.getPropertyString("mpv-version")}")
        holder?.let { if (it.surface?.isValid == true) attach(it) }
    }

    fun stop() {
        val lib = mpv ?: return
        mpv = null
        try {
            lib.detachSurface()
            lib.destroy()
        } catch (error: Throwable) {
            Log.w(TAG, "stop: $error")
        }
    }

    private fun attach(holder: SurfaceHolder) {
        val lib = mpv ?: return
        lib.attachSurface(holder.surface)
        lib.setOptionString("force-window", "yes")
        lib.setOptionString("vo", "gpu-next")
        val frame = holder.surfaceFrame
        lib.setPropertyString("android-surface-size", "${frame.width()}x${frame.height()}")
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        this.holder = holder
        attach(holder)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        mpv?.setPropertyString("android-surface-size", "${width}x$height")
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        this.holder = null
        val lib = mpv ?: return
        // Playback continues (audio) with no picture until the surface is back.
        lib.setOptionString("vo", "null")
        lib.setOptionString("force-window", "no")
        lib.detachSurface()
    }

    /** libass needs fontconfig pointed at the system fonts; none are bundled. */
    private fun writeFontsConf(configDir: File) {
        File(configDir, "fonts.conf").writeText(
            """
            <?xml version="1.0"?>
            <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
            <fontconfig>
              <dir>/system/fonts/</dir>
              <dir>/product/fonts/</dir>
              <cachedir>${File(context.cacheDir, "fontconfig").path}</cachedir>
            </fontconfig>
            """.trimIndent()
        )
    }

    private companion object {
        const val TAG = "R3Player"
    }
}
