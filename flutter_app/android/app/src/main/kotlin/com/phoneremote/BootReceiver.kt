package com.phoneremote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = context.getSharedPreferences(
            ConnectionForegroundService.PREFS_NAME, Context.MODE_PRIVATE
        )
        val url = prefs.getString("url", "") ?: return
        if (url.isEmpty()) return
        val svc = Intent(context, ConnectionForegroundService::class.java).apply {
            putExtra("url", url)
            putExtra("status", "Connecting...")
            putExtra("screenW", prefs.getInt("screenW", 0))
            putExtra("screenH", prefs.getInt("screenH", 0))
            putExtra("model", prefs.getString("model", "Android"))
        }
        context.startForegroundService(svc)
    }
}
