package com.phoneremote

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
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

    /** Package name of whatever is on screen right now, or null if unknown. */
    fun foregroundPackage(): String? = rootInActiveWindow?.packageName?.toString()

    // ── UI tree ───────────────────────────────────────────────────────────
    // Android already describes the screen as a structured tree; reading it
    // beats guessing coordinates off a screenshot. Each node carries its own
    // normalized centre so the existing tap tool can act on it directly.

    /** Payload guard — a pathological tree (long chat list) would otherwise
     *  produce a huge frame. Truncation is reported to the caller. */
    private val maxTreeNodes = 250

    /**
     * Flattens the visible accessibility tree.
     * @param includeAll false = only nodes an agent can act on or read.
     * @param sw/sh true screen size, passed in: the service's own
     *   displayMetrics excludes the nav bar and would skew every centre.
     * @return [nodes, truncated]
     */
    fun uiTree(includeAll: Boolean, sw: Float, sh: Float): Pair<JSONArray, Boolean> {
        val arr = JSONArray()
        val root = rootInActiveWindow ?: return Pair(arr, false)
        if (sw <= 0f || sh <= 0f) return Pair(arr, false)
        val truncated = walkNode(root, arr, includeAll, sw, sh)
        return Pair(arr, truncated)
    }

    /** @return true if the node cap was hit and the walk stopped early. */
    private fun walkNode(
        node: android.view.accessibility.AccessibilityNodeInfo?,
        arr: JSONArray,
        includeAll: Boolean,
        sw: Float,
        sh: Float
    ): Boolean {
        if (node == null) return false
        if (arr.length() >= maxTreeNodes) return true

        val text = node.text?.toString()?.trim()
        val desc = node.contentDescription?.toString()?.trim()
        val vid = node.viewIdResourceName
        // Layout containers carry no text and do nothing — including them would
        // bury the handful of nodes that matter in structural noise.
        val actionable = node.isClickable || node.isEditable || node.isCheckable || node.isScrollable
        val readable = !text.isNullOrEmpty() || !desc.isNullOrEmpty()

        if ((includeAll || actionable || readable) && node.isVisibleToUser) {
            val r = android.graphics.Rect()
            node.getBoundsInScreen(r)
            if (r.width() > 0 && r.height() > 0) {
                val o = JSONObject()
                o.put("i", arr.length())
                if (!text.isNullOrEmpty()) o.put("text", text.take(200))
                if (!desc.isNullOrEmpty()) o.put("desc", desc.take(200))
                if (!vid.isNullOrEmpty()) o.put("id", vid.substringAfter("id/", vid))
                o.put("cls", node.className?.toString()?.substringAfterLast('.') ?: "")
                o.put("x", round3(r.exactCenterX() / sw))
                o.put("y", round3(r.exactCenterY() / sh))
                // Compact flags: every byte here is repeated per node.
                val f = StringBuilder()
                if (node.isClickable) f.append('c')
                if (node.isEditable) f.append('e')
                if (node.isScrollable) f.append('s')
                if (node.isCheckable) f.append('k')
                if (node.isChecked) f.append('K')
                if (node.isFocused) f.append('f')
                if (!node.isEnabled) f.append('d')
                if (f.isNotEmpty()) o.put("f", f.toString())
                arr.put(o)
            }
        }
        for (i in 0 until node.childCount) {
            if (walkNode(node.getChild(i), arr, includeAll, sw, sh)) return true
        }
        return false
    }

    private fun round3(v: Float): Double = Math.round(v * 1000.0) / 1000.0

    /**
     * Dispatches a gesture and reports whether the system actually ran it.
     * Android can refuse a gesture outright (dispatchGesture returns false) or
     * cancel it mid-flight — both are silent failures unless we listen, which
     * is how a tap that never landed used to still be reported as a success.
     */
    private fun dispatchGestureWithResult(
        gesture: GestureDescription,
        onResult: ((Boolean) -> Unit)?
    ) {
        if (onResult == null) {
            dispatchGesture(gesture, null, null)
            return
        }
        var reported = false
        val report = { ok: Boolean -> if (!reported) { reported = true; onResult(ok) } }
        val cb = object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { report(true) }
            override fun onCancelled(d: GestureDescription?) { report(false) }
        }
        // A false return means the gesture was never queued, so neither
        // callback will ever fire — report the failure here or the caller hangs.
        if (!dispatchGesture(gesture, cb, null)) report(false)
    }

    // ── Tap ──────────────────────────────────────────────────────────────
    fun tap(x: Float, y: Float, onResult: ((Boolean) -> Unit)? = null) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        dispatchGestureWithResult(GestureDescription.Builder().addStroke(stroke).build(), onResult)
    }

    // ── Swipe ─────────────────────────────────────────────────────────────
    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long, onResult: ((Boolean) -> Unit)? = null) {
        val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(50))
        dispatchGestureWithResult(GestureDescription.Builder().addStroke(stroke).build(), onResult)
    }

    // ── Scroll ────────────────────────────────────────────────────────────
    fun scroll(x: Float, y: Float, deltaY: Float, onResult: ((Boolean) -> Unit)? = null) {
        val dist = (deltaY * 600).coerceIn(-800f, 800f)
        swipe(x, y, x, y - dist, 200, onResult)
    }

    // ── System keys ───────────────────────────────────────────────────────
    /** @return true only if the key actually took effect. */
    fun pressKey(keycode: String): Boolean {
        return when (keycode) {
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
                true
            }
            "KEYCODE_VOLUME_DOWN" -> {
                val audio = getSystemService(AUDIO_SERVICE) as android.media.AudioManager
                audio.adjustStreamVolume(
                    android.media.AudioManager.STREAM_MUSIC,
                    android.media.AudioManager.ADJUST_LOWER,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
                true
            }
            "KEYCODE_NOTIFICATION"   -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "KEYCODE_QUICK_SETTINGS" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "KEYCODE_DPAD_LEFT", "KEYCODE_DPAD_RIGHT" -> {
                val focused = rootInActiveWindow?.findFocus(
                    android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
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
                    android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
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
            else -> false
        }
    }

    /** @return true only if a focused text field accepted the edit. */
    private fun editFocusedText(transform: (String, Int, Int) -> Pair<String, Int>): Boolean {
        val focused = rootInActiveWindow?.findFocus(
            android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
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
        val ok = focused.performAction(
            android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, textArgs)
        val selArgs = Bundle()
        selArgs.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, newCursor)
        selArgs.putInt(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, newCursor)
        // Cursor placement is cosmetic — the edit itself is what succeeded or not.
        focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_SELECTION, selArgs)
        return ok
    }

    // ── Type text ─────────────────────────────────────────────────────────
    /** @return true only if a focused text field accepted the text. */
    fun typeText(text: String): Boolean =
        editFocusedText { cur, selStart, selEnd ->
            Pair(cur.substring(0, selStart) + text + cur.substring(selEnd), selStart + text.length)
        }

    /**
     * Types by putting the text on the clipboard and asking the focused field
     * to paste it.
     *
     * ACTION_SET_TEXT (what typeText uses) is advisory — WhatsApp and others
     * simply ignore it, so typing silently does nothing. Those apps do honour
     * ACTION_PASTE, which goes through the normal input path. Kept as an
     * explicit alternative rather than the default: pasting clobbers the
     * user's clipboard, which is rude to do on every keystroke.
     *
     * @return true only if a focused field accepted the paste.
     */
    fun pasteText(text: String): Boolean {
        val focused = rootInActiveWindow?.findFocus(
            android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        return try {
            val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("phone-remote", text))
            focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_PASTE)
        } catch (_: Exception) { false }
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
