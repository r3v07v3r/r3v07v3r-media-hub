plugins {
    id("com.android.application")
}

android {
    namespace = "com.r3v07v3r.spike"
    // Preinstalled on GitHub's ubuntu runners, and what the libmpv AAR itself
    // is built against.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.r3v07v3r.spike"
        // The libmpv AAR declares 26; anything lower fails the manifest merge.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-spike"

        ndk {
            // Many Android TV boxes run a 32-bit userspace. This only selects
            // which of the AAR's prebuilt libraries are packaged; nothing native
            // is compiled here.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // A throwaway measurement tool: a lint opinion must not cost a CI run.
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("dev.jdtech.mpv:libmpv:1.0.0")
}
