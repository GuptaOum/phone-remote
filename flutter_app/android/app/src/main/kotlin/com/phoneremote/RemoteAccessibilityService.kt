package com.phoneremote

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * RemoteAccessibilityService
 *
 * This is the core of touch injection. Android's AccessibilityService API
 * allows dispatching tap/swipe gestures without root access.
 *
 * SETUP REQUIRED by user:
 *   Settings → Accessibility → Phone Remote → Enable
 *
 * The app shows a prompt guiding the user to enable it.
 */
class RemoteAccessibilityService : AccessibilityService() {

    companion object {
        var instance: RemoteAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    // ── Tap ──────────────────────────────────────────────────────────────
    fun tap(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    // ── Swipe ─────────────────────────────────────────────────────────────
    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(50))
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    // ── Scroll ────────────────────────────────────────────────────────────
    fun scroll(x: Float, y: Float, deltaY: Float) {
        val dist = (deltaY * 600).coerceIn(-800f, 800f)
        swipe(x, y, x, y - dist, 200)
    }

    // ── System keys ───────────────────────────────────────────────────────
    fun pressKey(keycode: String) {
        when (keycode) {
            "KEYCODE_BACK"       -> performGlobalAction(GLOBAL_ACTION_BACK)
            "KEYCODE_HOME"       -> performGlobalAction(GLOBAL_ACTION_HOME)
            "KEYCODE_APP_SWITCH" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "KEYCODE_POWER"      -> performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            "KEYCODE_VOLUME_UP" -> {
                val audio = getSystemService(AUDIO_SERVICE) as android.media.AudioManager
                audio.adjustStreamVolume(
                    android.media.AudioManager.STREAM_MUSIC,
                    android.media.AudioManager.ADJUST_RAISE,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
            }
            "KEYCODE_VOLUME_DOWN" -> {
                val audio = getSystemService(AUDIO_SERVICE) as android.media.AudioManager
                audio.adjustStreamVolume(
                    android.media.AudioManager.STREAM_MUSIC,
                    android.media.AudioManager.ADJUST_LOWER,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
            }
            "KEYCODE_NOTIFICATION"   -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "KEYCODE_QUICK_SETTINGS" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "KEYCODE_DPAD_LEFT", "KEYCODE_DPAD_RIGHT" -> {
                val focused = rootInActiveWindow?.findFocus(
                    android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return
                val cur = focused.text?.toString() ?: ""
                val sel = if (keycode == "KEYCODE_DPAD_LEFT")
                    focused.textSelectionStart.let { if (it < 0) cur.length else it.coerceAtMost(cur.length) }
                else
                    focused.textSelectionEnd.let { if (it < 0) cur.length else it.coerceAtMost(cur.length) }
                val newPos = if (keycode == "KEYCODE_DPAD_LEFT")
                    (sel - 1).coerceAtLeast(0)
                else
                    (sel + 1).coerceAtMost(cur.length)
                val args = Bundle()
                args.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, newPos)
                args.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, newPos)
                focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION, args)
            }
            "KEYCODE_DPAD_UP", "KEYCODE_DPAD_DOWN" -> {
                val focused = rootInActiveWindow?.findFocus(
                    android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return
                val args = Bundle()
                args.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_MOVEMENT_GRANULARITY_INT,
                    android.view.accessibility.AccessibilityNodeInfo.MOVEMENT_GRANULARITY_LINE)
                args.putBoolean(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_EXTEND_SELECTION_BOOLEAN, false)
                val action = if (keycode == "KEYCODE_DPAD_UP")
                    android.view.accessibility.AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY
                else
                    android.view.accessibility.AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY
                focused.performAction(action, args)
            }
            "KEYCODE_DEL", "KEYCODE_FORWARD_DEL" -> editFocusedText { cur, selStart, selEnd ->
                when {
                    selStart != selEnd -> Pair(cur.substring(0, selStart) + cur.substring(selEnd), selStart)
                    keycode == "KEYCODE_DEL" && selStart > 0 ->
                        Pair(cur.substring(0, selStart - 1) + cur.substring(selStart), selStart - 1)
                    keycode == "KEYCODE_FORWARD_DEL" && selEnd < cur.length ->
                        Pair(cur.substring(0, selEnd) + cur.substring(selEnd + 1), selEnd)
                    else -> Pair(cur, selStart)
                }
            }
            "KEYCODE_ENTER" -> editFocusedText { cur, selStart, selEnd ->
                Pair(cur.substring(0, selStart) + "\n" + cur.substring(selEnd), selStart + 1)
            }
        }
    }

    private fun editFocusedText(transform: (String, Int, Int) -> Pair<String, Int>) {
        val focused = rootInActiveWindow?.findFocus(
            android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        val showingHint = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O &&
            focused.isShowingHintText
        val cur = if (showingHint) "" else (focused.text?.toString() ?: "")
        val selEnd = if (showingHint) 0 else focused.textSelectionEnd.let { if (it < 0) cur.length else it.coerceAtMost(cur.length) }
        val selStart = if (showingHint) 0 else focused.textSelectionStart.let { if (it < 0) selEnd else it.coerceAtMost(selEnd) }
        val (newText, newCursor) = transform(cur, selStart, selEnd)
        val textArgs = Bundle()
        textArgs.putCharSequence(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            newText)
        focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, textArgs)
        val selArgs = Bundle()
        selArgs.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, newCursor)
        selArgs.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, newCursor)
        focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION, selArgs)
    }

    // ── Type text ─────────────────────────────────────────────────────────
    fun typeText(text: String) {
        editFocusedText { cur, selStart, selEnd ->
            Pair(cur.substring(0, selStart) + text + cur.substring(selEnd), selStart + text.length)
        }
    }

    // ── Screenshot via AccessibilityService (API 30+, no MediaProjection needed) ──
    @RequiresApi(Build.VERSION_CODES.S)
    fun captureScreenshot(callback: (ByteArray) -> Unit) {
        takeScreenshot(
            android.view.Display.DEFAULT_DISPLAY,
            Executors.newSingleThreadExecutor(),
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                    try {
                        val hwBuffer = screenshot.hardwareBuffer
                        val bmp = Bitmap.wrapHardwareBuffer(hwBuffer, screenshot.colorSpace)!!
                        hwBuffer.close()
                        val softBmp = bmp.copy(Bitmap.Config.ARGB_8888, false)
                        bmp.recycle()
                        val out = ByteArrayOutputStream()
                        softBmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
                        softBmp.recycle()
                        callback(out.toByteArray())
                    } catch (_: Exception) { callback(byteArrayOf()) }
                }
                override fun onFailure(errorCode: Int) { callback(byteArrayOf()) }
            }
        )
    }

}
