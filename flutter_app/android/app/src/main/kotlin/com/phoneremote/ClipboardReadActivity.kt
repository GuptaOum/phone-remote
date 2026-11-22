package com.phoneremote

import android.app.Activity
import android.content.ClipboardManager
import android.os.Bundle

/**
 * Reads the clipboard for the get_clipboard tool.
 *
 * Since Android 10 only the app in front (or the keyboard) may read the
 * clipboard, so a background service can't. This invisible activity comes to
 * the front for a moment, reads the clipboard once it has window focus (the
 * earliest point Android allows it), hands the text to [pending] and closes.
 * It is started from the accessibility service's context, which Android lets
 * start activities from the background.
 *
 * Android 12+ shows its own "Phone Remote pasted from your clipboard" toast:
 * that is expected and tells the user it happened.
 */
class ClipboardReadActivity : Activity() {

    companion object {
        /** Set by the service before starting this activity; called once. */
        @Volatile
        var pending: ((ClipResult) -> Unit)? = null

        /** Long clips are cut so one copy can't flood the agent. */
        const val MAX_CHARS = 20000
    }

    data class ClipResult(
        val text: String?,
        val kind: String,      // "text", "uri", "empty"
        val label: String?,
        val truncated: Boolean,
        val error: String? = null,
    )

    private var done = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overridePendingTransition(0, 0)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        val result = try {
            read()
        } catch (e: Exception) {
            ClipResult(null, "empty", null, false, e.message ?: "Could not read the clipboard")
        }
        val cb = pending
        pending = null
        cb?.invoke(result)
        finish()
        overridePendingTransition(0, 0)
    }

    override fun onStop() {
        super.onStop()
        // Never stay around in the background.
        if (!isFinishing) finish()
    }

    private fun read(): ClipResult {
        val cm = getSystemService(ClipboardManager::class.java)
        val clip = cm?.primaryClip
        if (clip == null || clip.itemCount == 0) return ClipResult(null, "empty", null, false)
        val item = clip.getItemAt(0)
        val label = clip.description?.label?.toString()?.takeIf { it.isNotBlank() }
        val kind = if (item.text == null && item.uri != null) "uri" else "text"
        val full = item.coerceToText(this)?.toString() ?: ""
        if (full.isEmpty()) return ClipResult(null, "empty", label, false)
        val truncated = full.length > MAX_CHARS
        return ClipResult(if (truncated) full.take(MAX_CHARS) else full, kind, label, truncated)
    }
}
