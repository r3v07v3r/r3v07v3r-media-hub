plugins {
    // AGP 9 compiles Kotlin itself: no org.jetbrains.kotlin.android plugin.
    // Same toolchain the spike proved in CI (android-spike, PR #168).
    id("com.android.application") version "9.4.0" apply false
}
