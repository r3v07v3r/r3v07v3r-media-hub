plugins {
    id("com.android.application")
}

android {
    namespace = "com.r3v07v3r.mediahub"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.r3v07v3r.mediahub"
        // libmpv (the player, next) declares 26.
        minSdk = 26
        targetSdk = 36
        // CI passes the run number so every build installs over the last one.
        versionCode = (System.getenv("R3_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("R3_VERSION_NAME") ?: "0.1-dev"

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
