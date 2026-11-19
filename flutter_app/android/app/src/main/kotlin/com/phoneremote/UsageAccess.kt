package com.phoneremote

import android.app.AppOpsManager
import android.content.Context
import android.os.Build
import android.os.Process

/**
 * "Usage access" (PACKAGE_USAGE_STATS) is a special permission the user turns
 * on in Settings → Usage access. Android needs it before StorageStatsManager
 * will report how much storage OTHER apps use (list_apps with sizes).
 */
object UsageAccess {
    fun granted(ctx: Context): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        } else {
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }
}
