plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nexo.camara"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nexo.camara"
        // Android 8: de ahi en adelante MediaCodec y Camera2 se portan igual en casi
        // todos los moviles.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Sin dependencias a proposito: solo la plataforma (Camera2, MediaCodec, org.json).
