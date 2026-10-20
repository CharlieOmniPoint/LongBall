package dev.longball.nativeclock

import android.os.SystemClock
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/** M0 experiment: elapsedRealtime advances during deep sleep; BOOT_COUNT fences reboot recovery. */
class LongBallNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LongBallNative")

    Function("readClock") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val bootCount = try {
        Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
      } catch (_: Exception) {
        null
      }
      mapOf(
        "monotonicMs" to SystemClock.elapsedRealtime().toDouble(),
        "continuityId" to bootCount?.let { "android-boot-$it" },
        "source" to "android_elapsed_realtime",
        "verifiedContinuous" to (bootCount != null)
      )
    }

    Function("storageDirectory") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      // Android excludes noBackupFilesDir from both cloud backup and device transfer.
      // Keep database, WAL, SHM and rollback journal together under this directory.
      val directory = File(context.noBackupFilesDir, "longball")
      if (!directory.isDirectory && !directory.mkdirs()) {
        throw IllegalStateException("Cannot create the backup-excluded LongBall journal directory")
      }
      val existing = listOf("", "-wal", "-shm", "-journal")
        .any { File(directory, "longball-m0.db$it").exists() }
      mapOf(
        "directory" to directory.absolutePath,
        "backupExcluded" to true,
        "existingJournal" to existing
      )
    }
  }
}
