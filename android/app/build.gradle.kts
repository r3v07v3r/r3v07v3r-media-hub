plugins {
    id("com.android.application")
}

/**
 * The version code, derived from the release name so Android and the app's
 * update check (Updater.kt, which applies the same rule to release tags)
 * agree on "newer": 1.0.84-preview.130 < 1.0.84 < 1.0.85-preview.1.
 * Dev builds are named 0.1.<run> and sit below every release.
 */
fun versionCodeOf(name: String): Int {
    val match = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?""").find(name) ?: return 1
    val (major, minor, patch, preview) = match.destructured
    val base = (major.toInt() * 100 + minor.toInt()) * 1000 + patch.toInt()
    val step = if (preview.isEmpty()) 9999 else minOf(preview.toInt(), 9998)
    return base * 10000 + step
}

val r3VersionName = System.getenv("R3_VERSION_NAME") ?: "0.1.0"

/**
 * The release key, which is never in the repository. CI passes it in on
 * release runs only (.github/workflows/android.yml; setup in android/README.md,
 * "Release signing"). All four or none: with none set the build is signed with
 * the debug key below, exactly as before. A partial set is a broken setup, and
 * quietly falling back to the debug key would ship an APK that cannot install
 * over a release-signed one, so it stops the build instead.
 */
val releaseSigning: Map<String, String>? = listOf(
    "R3_ANDROID_KEYSTORE_FILE",
    "R3_ANDROID_KEYSTORE_PASSWORD",
    "R3_ANDROID_KEY_ALIAS",
    "R3_ANDROID_KEY_PASSWORD",
).associateWith { System.getenv(it).orEmpty() }.let { values ->
    val missing = values.filterValues { it.isEmpty() }.keys
    when {
        missing.isEmpty() -> values
        missing.size == values.size -> null
        else -> throw GradleException(
            "Release signing is half set up. Missing: ${missing.joinToString(", ")}. " +
                "Set all four R3_ANDROID_* variables to sign with the release key, or none to sign with the debug key."
        )
    }
}

android {
    namespace = "com.r3v07v3r.mediahub"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.r3v07v3r.mediahub"
        // libmpv (the player, next) declares 26.
        minSdk = 26
        targetSdk = 36
        versionName = r3VersionName
        versionCode = versionCodeOf(r3VersionName)

        ndk {
            // The bundled Node is Termux's aarch64 build. 32-bit boxes
            // (armeabi-v7a) need Termux's `arm` build staged the same way.
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        getByName("debug") {
            // A fixed debug key, committed on purpose: CI runners start
            // clean, and a fresh key per build would make every new APK
            // refuse to install over the last one (and uninstalling wipes
            // the app's data). It signs test builds only; release signing
            // will use a key that is NOT in the repository.
            storeFile = rootProject.file("debug.p12")
            storeType = "pkcs12"
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        releaseSigning?.let { key ->
            create("release") {
                storeFile = file(key.getValue("R3_ANDROID_KEYSTORE_FILE"))
                storeType = "pkcs12"
                storePassword = key.getValue("R3_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = key.getValue("R3_ANDROID_KEY_ALIAS")
                keyPassword = key.getValue("R3_ANDROID_KEY_PASSWORD")
            }
        }
    }

    if (releaseSigning != null) {
        buildTypes {
            // Still the debug build type the workflow has always shipped
            // (assembleDebug; MainActivity keeps chrome://inspect on for it),
            // only signed with the release key instead of debug.p12.
            getByName("debug") {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    packaging {
        jniLibs {
            // Libraries must exist as real files on disk: `libnode.so` is
            // EXECUTED from the native library directory, not dlopen'ed from
            // inside the APK. See Backend.kt.
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    // The player: libmpv + ffmpeg, the build Findroid ships (proven in the
    // Android spike). GPL — see android/README.md.
    implementation("dev.jdtech.mpv:libmpv:1.0.0")
    // The pairing-code scanner (Google Play services; no camera permission).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
