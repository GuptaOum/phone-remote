package com.phoneremote

import android.app.Notification
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * NotificationService
 *
 * Lets an agent read what the phone is telling the user — OTP codes, delivery
 * confirmations, incoming messages. Without this, an agent driving a login flow
 * hits the "enter the code we just sent" step and is simply stuck.
 *
 * SETUP REQUIRED by user (separate from the Accessibility grant, and not
 * requestable at runtime — Android only allows sending the user to the screen):
 *   Settings → Notifications → Device & app notifications → Phone Remote → Allow
 *
 * Active notifications come straight from the system. We additionally keep a
 * small history buffer because the interesting ones (an OTP) are often swiped
 * away or auto-dismissed before an agent gets round to asking.
 */
class NotificationService : NotificationListenerService() {

    companion object {
        var instance: NotificationService? = null
            private set

        private const val MAX_HISTORY = 50

        /** Recent notifications, newest last. Guarded by its own lock — the
         *  system posts on its thread, the WebSocket reads on ours. */
        private val history = ArrayList<JSONObject>()

        /** Whether the user has granted notification access. The listener is
         *  only bound when they have, so `instance` alone can't distinguish
         *  "not granted" from "granted but not yet bound". */
        fun isGranted(ctx: Context): Boolean = try {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")
            !flat.isNullOrEmpty() && flat.contains(ctx.packageName)
        } catch (_: Exception) { false }

        fun snapshot(): JSONArray = synchronized(history) { JSONArray(history.toList()) }

        private fun remember(o: JSONObject) = synchronized(history) {
            history.add(o)
            while (history.size > MAX_HISTORY) history.removeAt(0)
        }
    }

    override fun onListenerConnected() { instance = this }
    override fun onListenerDisconnected() { instance = null }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val o = toJson(sbn ?: return) ?: return
        remember(o)
    }

    /** Currently-showing notifications, or null if we aren't bound. */
    fun active(): JSONArray? = try {
        val arr = JSONArray()
        activeNotifications?.forEach { sbn -> toJson(sbn)?.let { arr.put(it) } }
        arr
    } catch (_: Exception) { null }

    private fun toJson(sbn: StatusBarNotification): JSONObject? = try {
        val ex = sbn.notification?.extras
        val title = ex?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        // BIG_TEXT carries the full body when the notification is expanded;
        // EXTRA_TEXT is often truncated with an ellipsis, which would cut an
        // OTP out of a longer message.
        val text = (ex?.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: ex?.getCharSequence(Notification.EXTRA_TEXT))?.toString()
        if (title.isNullOrBlank() && text.isNullOrBlank()) null
        else JSONObject().apply {
            put("package", sbn.packageName)
            if (!title.isNullOrBlank()) put("title", title.take(300))
            if (!text.isNullOrBlank()) put("text", text.take(1000))
            put("postedAt", sbn.postTime)
            put("clearable", sbn.isClearable)
        }
    } catch (_: Exception) { null }
}
