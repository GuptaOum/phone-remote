# libwebrtc (io.github.webrtc-sdk:android) ships NO shrinker rules of its own.
# Its native code finds Java classes, methods and fields by exact name over JNI;
# if R8 renames or strips any of them the app aborts (uncatchable native crash)
# the moment WebRTC starts — the phone drops right after "Start now" on the
# screen-cast prompt. Checked after every release build by
# tool/verify_release_apk.sh.

# BUG-R1: the org.webrtc API classes.
-keep class org.webrtc.** { *; }
-keep interface org.webrtc.** { *; }
-dontwarn org.webrtc.**

# BUG-R2: jni_zero, the JNI bridge libwebrtc's JNI_OnLoad initialises first
# (SIGTRAP inside JNI_OnLoad when it was stripped).
-keep class org.jni_zero.** { *; }
-keep @interface org.jni_zero.** { *; }
-dontwarn org.jni_zero.**

# Anything native code calls or reads, wherever it lives (same rules jni_zero
# uses upstream).
-keepattributes *Annotation*
-keepclasseswithmembers,includedescriptorclasses class ** {
    @org.jni_zero.CalledByNative <methods>;
}
-keepclasseswithmembers,includedescriptorclasses class ** {
    @org.jni_zero.CalledByNativeUnchecked <methods>;
}
-keepclasseswithmembers,includedescriptorclasses class ** {
    @org.jni_zero.AccessedByNative <fields>;
}
-keepclasseswithmembernames,includedescriptorclasses class ** {
    native <methods>;
}
