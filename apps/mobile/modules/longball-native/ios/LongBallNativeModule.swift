import Darwin
import ExpoModulesCore
import Foundation

/** M0 experiment: mach_continuous_time includes sleep; boot session UUID fences reboot recovery. */
public class LongBallNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LongBallNative")

    Function("readClock") { () -> [String: Any] in
      var timebase = mach_timebase_info_data_t()
      let result = mach_timebase_info(&timebase)
      guard result == KERN_SUCCESS && timebase.denom != 0 else {
        throw NSError(domain: "LongBallNative", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "Continuous clock timebase is unavailable"
        ])
      }
      // Convert before multiplication to avoid overflowing a UInt64 nanosecond product.
      let milliseconds = Double(mach_continuous_time()) * Double(timebase.numer)
        / Double(timebase.denom) / 1_000_000
      let bootSession = Self.bootSessionIdentifier()
      return [
        "monotonicMs": milliseconds,
        "continuityId": bootSession.map { "ios-boot-\($0)" } as Any? ?? NSNull(),
        "source": "ios_mach_continuous_time",
        "verifiedContinuous": bootSession != nil
      ]
    }

    Function("storageDirectory") { () -> [String: Any] in
      let fileManager = FileManager.default
      var directory = try fileManager.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      ).appendingPathComponent("LongBall", isDirectory: true)
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      let excluded = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        .isExcludedFromBackup == true
      let existing = ["", "-wal", "-shm", "-journal"].contains { suffix in
        fileManager.fileExists(atPath: directory.appendingPathComponent("longball-m0.db\(suffix)").path)
      }
      return [
        "directory": directory.path,
        "backupExcluded": excluded,
        "existingJournal": existing
      ]
    }
  }

  private static func bootSessionIdentifier() -> String? {
    var length = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &length, nil, 0) == 0,
      length > 1 && length < 1_024 else { return nil }
    var bytes = [CChar](repeating: 0, count: length)
    let result = bytes.withUnsafeMutableBufferPointer { buffer in
      sysctlbyname("kern.bootsessionuuid", buffer.baseAddress, &length, nil, 0)
    }
    guard result == 0 else { return nil }
    let value = String(cString: bytes)
    return value.isEmpty ? nil : value
  }
}
