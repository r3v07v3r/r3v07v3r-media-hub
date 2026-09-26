pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // dev.jdtech.mpv:libmpv — the libmpv build Findroid ships.
        mavenCentral()
    }
}
rootProject.name = "r3-spike"
include(":app")
