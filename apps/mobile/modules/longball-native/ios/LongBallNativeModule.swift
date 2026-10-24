import Darwin
import ExpoModulesCore
import Foundation
import AVFoundation

/** M0 experiment: mach_continuous_time includes sleep; boot session UUID fences reboot recovery. */
public class LongBallNativeModule: Module {
  private var substitutionPlayer: AVAudioPlayer?
  public func definition() -> ModuleDefinition {
    Name("LongBallNative")

    Function("playSubstitutionTone") { (volume: Double) -> Bool in
      guard volume.isFinite && volume >= 0 && volume <= 1 else { return false }
      self.substitutionPlayer?.stop()
      if volume == 0 { return true }
      do {
        // Ambient respects the silent switch and does not interrupt other audio.
        try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default)
        let player = try AVAudioPlayer(data: Self.substitutionWave())
        player.volume = Float(volume)
        self.substitutionPlayer = player
        return player.play()
      } catch { return false }
    }
    Function("stopSubstitutionTone") { self.substitutionPlayer?.stop() }
    OnDestroy { self.substitutionPlayer?.stop(); self.substitutionPlayer = nil }

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

  private static func substitutionWave() -> Data {
    let rate = 22_050
    let count = Int(Double(rate) * 0.4)
    let byteCount = UInt32(count * 2)
    var data = Data()
    func text(_ value: String) { data.append(value.data(using: .ascii)!) }
    func number<T: FixedWidthInteger>(_ value: T) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    text("RIFF"); number(UInt32(36) + byteCount); text("WAVEfmt ")
    number(UInt32(16)); number(UInt16(1)); number(UInt16(1))
    number(UInt32(rate)); number(UInt32(rate * 2)); number(UInt16(2)); number(UInt16(16))
    text("data"); number(byteCount)
    for index in 0..<count {
      let time = Double(index) / Double(rate)
      let frequency = time < 0.18 ? 660.0 : 880.0
      let envelope = min(1, time / 0.015, max(0, (0.4 - time) / 0.04))
      number(Int16(sin(2 * Double.pi * frequency * time) * envelope * 8_000))
    }
    return data
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
