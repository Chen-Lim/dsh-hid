// DshDaemon.swift - DeepSeek Harness (DSH) Swift 6 Native Peripheral Daemon & S4 HID Bridge
// Upgraded from NuPhyLab-next (v1.2.44) native/HIDBridge.swift with Swift 6 strict concurrency
// and native JSON-RPC 2.0 WebSocket client + 84-key Codex Micro status renderer.
// Build: swiftc -swift-version 6 -strict-concurrency=complete -O packages/daemon/native/DshDaemon.swift -o packages/daemon/bin/dsh-daemon
import Foundation
import CryptoKit
import IOKit
import IOKit.hid
import CoreGraphics
import AppKit
import ApplicationServices
import Darwin
import IOKit.hidsystem

struct NuphyDeviceProfile: Sendable, Equatable {
    let model: String
    let wiredPID: Int
    let reportSize: Int

    static let supported: [NuphyDeviceProfile] = [
        NuphyDeviceProfile(model: "Air75 V3", wiredPID: 0x1028, reportSize: 64),
        NuphyDeviceProfile(model: "Kick75", wiredPID: 0x1026, reportSize: 64),
        NuphyDeviceProfile(model: "Node75 LP", wiredPID: 0x1030, reportSize: 64),
        NuphyDeviceProfile(model: "Node75 HP", wiredPID: 0x1031, reportSize: 64),
        NuphyDeviceProfile(model: "Air65 V3", wiredPID: 0x102b, reportSize: 64),
        NuphyDeviceProfile(model: "Air100 V3", wiredPID: 0x102d, reportSize: 64),
        NuphyDeviceProfile(model: "Node100 LP", wiredPID: 0x1037, reportSize: 64),
        NuphyDeviceProfile(model: "Node100 HP", wiredPID: 0x1036, reportSize: 64),
    ]

    static let allowedProductIDs: Set<Int> = Set(supported.map { $0.wiredPID })

    static func resolve(productID: Int) -> (profile: NuphyDeviceProfile, transport: String, isDongle: Bool)? {
        for profile in supported {
            if profile.wiredPID == productID {
                return (profile, "USB", false)
            }
        }
        return nil
    }
}

final class BluetoothKeyboard {
    static func matches(_ p: [String:Any]) -> Bool {
        guard (p["VendorID"] as? NSNumber)?.intValue == 2007,
              (p["ProductID"] as? NSNumber)?.intValue == 0,
              ["Bluetooth", "Bluetooth Low Energy"].contains(p["Transport"] as? String ?? ""),
              (p["Manufacturer"] as? String)?.lowercased() == "nuphy",
              let product = p["Product"] as? String else { return false }
        return product.range(of: "^(NuPhy )?(Air(65|75|96|100) V3|Kick75|NODE(75|100)( [LH]P)?)(-[123])?$", options: .regularExpression) != nil
    }
    static func identities() -> [[String:Any]] {
        var found = [String:[String:Any]]()
        let manager=IOHIDManagerCreate(kCFAllocatorDefault,IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager,[kIOHIDPrimaryUsagePageKey:1,kIOHIDPrimaryUsageKey:6] as CFDictionary)
        // CopyDevices enumerates without opening the HID device or registering
        // input callbacks. Service clients omit the Bluetooth manufacturer.
        for device in IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> ?? [] {
            var properties = [String:Any]()
            for key in ["VendorID","ProductID","Transport","Manufacturer","Product"] {
                properties[key] = IOHIDDeviceGetProperty(device,key as CFString)
            }
            var registry: UInt64=0
            guard Self.matches(properties), IORegistryEntryGetRegistryEntryID(IOHIDDeviceGetService(device),&registry)==KERN_SUCCESS else { continue }
            let location = IOHIDDeviceGetProperty(device,"LocationID" as CFString) as? NSNumber
            let group = location?.uint64Value ?? 0
            let identity = group > 0 ? "location-\(group)" : "service-\(registry)"
            found[identity] = ["id":String(registry),"locationId":UInt32(truncatingIfNeeded:group)]
        }
        return found.values.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }
    }
    func snapshot() -> [String:Any] {
        ["devices":Self.identities().map { ["id":$0["id"]!,"model":"Air75 V3","transport":"bluetooth"] }]
    }

    /// Best-effort standard HID Output Report control for Bluetooth keyboard LEDs (Bit 1 = Caps Lock)
    /// Fails closed and silently when macOS holds exclusive access to the HOGP keyboard driver.
    @discardableResult static func setCapsLockLED(on: Bool) -> Bool {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager, [kIOHIDPrimaryUsagePageKey: 1, kIOHIDPrimaryUsageKey: 6] as CFDictionary)
        let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> ?? []
        for device in devices {
            var properties = [String: Any]()
            for key in ["VendorID", "ProductID", "Transport", "Manufacturer", "Product"] {
                properties[key] = IOHIDDeviceGetProperty(device, key as CFString)
            }
            guard Self.matches(properties) else { continue }
            var report: [UInt8] = [on ? 0x02 : 0x00]
            let status = report.withUnsafeMutableBytes { buf in
                IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, 0, buf.baseAddress!.assumingMemoryBound(to: UInt8.self), buf.count)
            }
            if status == kIOReturnSuccess {
                return true
            }
            let opened = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
            if opened == kIOReturnSuccess {
                let retry = report.withUnsafeMutableBytes { buf in
                    IOHIDDeviceSetReport(device, kIOHIDReportTypeOutput, 0, buf.baseAddress!.assumingMemoryBound(to: UInt8.self), buf.count)
                }
                IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone))
                if retry == kIOReturnSuccess {
                    return true
                }
            }
        }
        return false
    }

    static func shouldIlluminateCapsLockLED(status: DshAgentStatus, elapsedMs: Double) -> Bool {
        switch status {
        case .needsInput:
            let period = 1000.0
            let cycle = elapsedMs.truncatingRemainder(dividingBy: period)
            return cycle < 500.0
        case .error:
            let clamped = min(elapsedMs, 1000.0)
            guard clamped < 900.0 else { return false }
            let cycle = clamped.truncatingRemainder(dividingBy: 300.0)
            return cycle < 150.0
        case .inactive, .idle, .running, .completed:
            return false
        }
    }
}
final class KeyAdaptation {
    private var client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
    private let journal: URL
    private let property = "UserKeyMapping" as CFString
    private let src = "HIDKeyboardModifierMappingSrc", dst = "HIDKeyboardModifierMappingDst"
    init(journal: URL) { self.journal = journal }
    private func services() -> [IOHIDServiceClient] {
        let locations=Set(BluetoothKeyboard.identities().compactMap{$0["locationId"] as? UInt32}.filter{$0 != 0})
        return (IOHIDEventSystemClientCopyServices(client) as? [IOHIDServiceClient] ?? []).filter {
            let transport=IOHIDServiceClientCopyProperty($0,"Transport" as CFString) as? String ?? ""
            if transport == "USB" {return USBKeyboardModel.identify(vendor:Int(number($0,"VendorID")),product:Int(number($0,"ProductID"))) != nil}
            let product=IOHIDServiceClientCopyProperty($0,"Product" as CFString) as? String ?? ""
            return ["Bluetooth","Bluetooth Low Energy"].contains(transport) && number($0,"VendorID")==2007 && number($0,"ProductID")==0 &&
                product.range(of:"^(NuPhy )?Air75 V3(-[123])?$",options:.regularExpression) != nil &&
                locations.contains(UInt32(truncatingIfNeeded:number($0,"LocationID")))
        }
    }
    private func targetServices(_ command:[String:Any]) throws -> [IOHIDServiceClient] {
        if command["transport"] as? String == "bluetooth" {
            let devices=BluetoothKeyboard.identities()
            guard devices.count==1,let location=devices[0]["locationId"] as? UInt32,location>0 else {
                throw failure("DEVICE_NOT_FOUND","请只连接要适配的一把 Air75 V3 蓝牙键盘。")
            }
            // macOS sign-extends the service's 32-bit location, while the HID
            // device reports it unsigned. Compare the same 32-bit identity.
            return services().filter { UInt32(truncatingIfNeeded:number($0,"LocationID"))==location &&
                IOHIDServiceClientCopyProperty($0,"Transport" as CFString) as? String != "USB" }
        }
        guard command["transport"] == nil,let location=command["locationId"] as? UInt64,location>0 else {
            throw failure("KEY_MAPPING_INVALID","按键适配参数无效。")
        }
        return services().filter { number($0,"LocationID")==location &&
            IOHIDServiceClientCopyProperty($0,"Transport" as CFString) as? String == "USB" }
    }
    static let keycapUsages:[UInt64] = [0xc00000070,0xc0000006f,0xff0100000010,0xc00000221,0xc000000cf,0x10000009b,0xc000000b6,0xc000000cd,0xc000000b5,0xc000000e2,0xc000000ea,0xc000000e9]
    static func validMappings(_ rows:[[String:UInt64]],bluetooth:Bool,keycaps:Bool=false) -> Bool {
        let src="HIDKeyboardModifierMappingSrc",dst="HIDKeyboardModifierMappingDst"
        return rows.count<=12 && Set(rows.compactMap{$0[src]}).count==rows.count && rows.allSatisfy { row in
            guard let source=row[src],let target=row[dst] else{return false}
            if keycaps {
                guard (0x700000068...0x700000073).contains(source) else{return false}
                return keycapUsages[Int(source-0x700000068)]==target
            }
            guard (0x70000003a...0x700000045).contains(target) else{return false}
            if bluetooth {return source==target+46} // F13–F24 → corresponding F1–F12 only.
            let allowed:Set<UInt64>=[0x700000069,0x70000006a,0xc000000b6,0xc000000cd,0xc000000b5,0xc000000e2,0xc000000ea,0xc000000e9,0xc0000029f,0xc000000cf,0x10000009b]
            return source==target+46 || allowed.contains(source)
        }
    }
    static func serviceAcceptsSource(_ source:UInt64, conforms:(UInt32,UInt32)->Bool) -> Bool {
        switch UInt32(source >> 32) {
        case 7: return conforms(1,6)
        case 12: return conforms(12,1)
        case 1: return conforms(1,0x80) // System Control, including Do Not Disturb.
        default: return false
        }
    }
    private func number(_ service: IOHIDServiceClient, _ key: String) -> UInt64 {
        (IOHIDServiceClientCopyProperty(service,key as CFString) as? NSNumber)?.uint64Value ?? 0
    }
    private func id(_ service: IOHIDServiceClient) -> String {
        String((IOHIDServiceClientGetRegistryID(service) as? NSNumber)?.uint64Value ?? 0)
    }
    private func sessionStillExists(_ registry: String) -> Bool {
        // A failed inventory or temporarily missing Bluetooth metadata is not
        // evidence that a service disappeared. Retain its recovery record.
        guard let all = IOHIDEventSystemClientCopyServices(client) as? [IOHIDServiceClient] else { return true }
        return all.contains(where:{id($0)==registry})
    }
    private func mappings(_ service: IOHIDServiceClient) throws -> [[String:UInt64]] {
        guard let raw = IOHIDServiceClientCopyProperty(service,property) else { return [] }
        guard let list = raw as? [[String:UInt64]], list.count <= 1024,
              list.allSatisfy({$0[src] != nil && $0[dst] != nil}) else {
            throw failure("KEY_MAPPING_FORMAT", "已有系统键位映射无法安全读取，未覆盖它。")
        }
        return list
    }
    static func writeVerified(_ rows: [[String:UInt64]], read: () throws -> [[String:UInt64]],
                              set: () -> Bool, settle: () -> Void) throws {
        // Restoring an already restored service must not require another write.
        if try read() == rows { return }
        let accepted = set()
        // HID service properties can lag behind SetProperty. Read again without
        // repeating the write or overwriting a subsequent change by another app.
        for attempt in 0..<6 {
            if attempt > 0 { settle() }
            if try read() == rows { return }
        }
        throw failure("KEY_MAPPING_DENIED", "系统未确认按键适配（写入应答：\(accepted)），请重试。")
    }
    private func write(_ service: IOHIDServiceClient, _ rows: [[String:UInt64]]) throws {
        try Self.writeVerified(rows, read: { try self.mappings(service) },
            set: { IOHIDServiceClientSetProperty(service,self.property,rows as CFArray) },
            settle: { pump(0.05) })
    }
    private func save(_ records: [[String:Any]]) throws {
        try FileManager.default.createDirectory(at:journal.deletingLastPathComponent(),withIntermediateDirectories:true)
        try JSONSerialization.data(withJSONObject:records).write(to:journal,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:journal.path)
    }
    func restore() throws -> [String:Any] {
        guard FileManager.default.fileExists(atPath:journal.path) else { return ["restored":true] }
        client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
        let raw = try JSONSerialization.jsonObject(with:Data(contentsOf:journal))
        guard let records = raw as? [[String:Any]],records.count <= 16 else {
            throw failure("KEY_MAPPING_BACKUP", "按键适配备份无法读取，已保留原文件。")
        }
        let devices = services()
        var pending = [[String:Any]]()
        for record in records {
            guard let registry = record["registry"] as? String,
                  let before = record["before"] as? [[String:UInt64]],
                  let installed = record["installed"] as? [[String:UInt64]] else {
                throw failure("KEY_MAPPING_BACKUP", "按键适配备份格式无效。")
            }
            // Registry IDs identify this device session. Unplugged services and
            // their in-memory properties no longer exist; never restore to a replacement.
            guard let service = devices.first(where:{id($0)==registry}) else { continue }
            do {
                var current = try mappings(service)
                for row in installed {
                    guard let source = row[src], let target = row[dst] else { continue }
                    // Preserve changes made by another utility after our install.
                    guard current.contains(where:{$0[src]==source && $0[dst]==target}) else { continue }
                    current.removeAll(where:{$0[src]==source})
                    current += before.filter({$0[src]==source})
                }
                try write(service,current)
            } catch {
                // A removed service loses its temporary mapping with it. Never
                // apply a saved mapping to a newly enumerated device session.
                if sessionStillExists(registry) {
                    diagnostic("Key restore failed for service \(registry): \(error)")
                    pending.append(record)
                }
            }
        }
        if pending.isEmpty { try FileManager.default.removeItem(at:journal) }
        else { try save(pending);throw failure("KEY_MAPPING_RESTORE", "部分按键尚未恢复，备份已保留，请重试恢复。") }
        return ["restored":true]
    }
    func apply(_ command: [String:Any], requireInputMonitoring: Bool = true) throws -> [String:Any] {
        guard let rows = command["mappings"] as? [[String:UInt64]],
              command["profile"] == nil || command["profile"] as? String == "keycaps",
              Self.validMappings(rows,bluetooth:command["transport"] as? String == "bluetooth",keycaps:command["profile"] as? String == "keycaps") else { throw failure("KEY_MAPPING_INVALID", "按键适配参数无效。") }
        _ = try restore()
        // Do not keep an event-service snapshot across disconnects/reconnects.
        // Resolve after restore so the retained client owns these service refs.
        client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
        let devices = try targetServices(command)
        if rows.isEmpty { return ["applied":true,"verified":true,"services":0] }
        if requireInputMonitoring {
            guard IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted else { throw failure("INPUT_MONITORING_REQUIRED", "请先允许输入监控，再继续适配。") }
        }
        guard !devices.isEmpty else { throw failure("DEVICE_NOT_FOUND", "请连接要适配的键盘。") }
        var records = [[String:Any]]()
        do {
            for service in devices {
                let relevant = rows.filter { row in
                    Self.serviceAcceptsSource(row[src]!, conforms: { IOHIDServiceClientConformsTo(service,$0,$1) != 0 })
                }
                if relevant.isEmpty {continue}
                let before = try mappings(service)
                let sources = Set(relevant.compactMap{$0[src]})
                guard !before.contains(where:{ sources.contains($0[src] ?? 0) && !relevant.contains($0) }) else {
                    throw failure("KEY_MAPPING_CONFLICT", "这些媒体键已有自定义映射，未覆盖它；请先恢复原映射或在官方驱动中设置标准 F 键。")
                }
                let installed = relevant.filter { !before.contains($0) }
                if installed.isEmpty { continue }
                records.append(["registry":id(service),"before":before,"installed":installed])
                try save(records) // Durable before the first mutation.
                try write(service,before+installed)
            }
            for row in rows {
                guard try devices.contains(where:{ try mappings($0).contains(row) }) else {
                    throw failure("KEY_MAPPING_UNSUPPORTED", "此系统未接受媒体键转换，请使用官方驱动设置标准 F 键。")
                }
            }
            return ["applied":true,"verified":true,"services":records.count]
        } catch { _ = try restore(); throw error }
    }
    func status(_ command: [String:Any]) throws -> [String:Any] {
        guard let rows=command["mappings"] as? [[String:UInt64]],
              command["profile"] == nil || command["profile"] as? String == "keycaps",
              Self.validMappings(rows,bluetooth:command["transport"] as? String == "bluetooth",keycaps:command["profile"] as? String == "keycaps") else {
            throw failure("KEY_MAPPING_INVALID", "按键适配参数无效。")
        }
        client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
        let devices=try targetServices(command)
        let verified = try !devices.isEmpty && rows.allSatisfy { row in
            try devices.contains { try mappings($0).contains(row) }
        }
        return ["verified":verified]
    }
}


struct BridgeError: Error, CustomStringConvertible, @unchecked Sendable {
    let code: String
    let message: String
    var controlDiagnostic: [String:Any]? = nil
    var rotaryDiagnostic: [String:Any]? = nil
    var description: String { "\(code): \(message)" }
    var json: [String: Any] {
        var value: [String:Any] = ["code":code,"message":message]
        if let controlDiagnostic=controlDiagnostic {value["controlDiagnostic"]=controlDiagnostic}
        if let rotaryDiagnostic=rotaryDiagnostic {value["rotaryDiagnostic"]=rotaryDiagnostic}
        return value
    }
}

func failure(_ code: String, _ message: String) -> BridgeError {
    BridgeError(code: code, message: message)
}
func diagnostic(_ message: String) {
    writePipe(STDERR_FILENO, Data((message + "\n").utf8))
}
func writePipe(_ descriptor:Int32, _ data:Data) {
    data.withUnsafeBytes { raw in
        var offset=0
        while offset<raw.count {
            let written=Darwin.write(descriptor,raw.baseAddress!.advanced(by:offset),raw.count-offset)
            if written>0 {offset+=written}
            else if written==0 || errno != EINTR {break}
        }
    }
}
func permissionSnapshot() -> [String: Any] {
    ["inputMonitoring": IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted,
     "accessibility": AXIsProcessTrusted(),
     "canPostEvents": IOHIDCheckAccess(kIOHIDRequestTypePostEvent) == kIOHIDAccessTypeGranted,
     "promptsRequested": false]
}
func permissionSettingsURL(_ value: Any?) throws -> URL {
    let pane: String
    switch value as? String {
    case "inputMonitoring": pane = "Privacy_ListenEvent"
    case "accessibility": pane = "Privacy_Accessibility"
    default: throw failure("INVALID_PERMISSION", "仅支持输入监控和辅助功能设置。")
    }
    return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
}
func openPermissionSettings(_ permission: Any?) throws -> [String: Any] {
    let url = try permissionSettingsURL(permission)
    // The app uses its own permission bridge. The standalone/browser fallback
    // still needs to request trust before opening a page on a clean Mac.
    if permission as? String == "inputMonitoring", IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
        _ = CGRequestListenEventAccess()
    } else if permission as? String == "accessibility", !AXIsProcessTrusted() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt":true] as CFDictionary)
    }
    guard NSWorkspace.shared.open(url) else {
        throw failure("SETTINGS_OPEN_FAILED", "无法打开系统设置，请在“隐私与安全性”中打开对应权限页面。")
    }
    // A request does not grant access; report only a fresh preflight result.
    return ["opened": true, "permission": permission as! String, "permissions": permissionSnapshot()]
}
func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    var output = data; output.append(10)
    // A vanished parent must not throw an Objective-C broken-pipe exception
    // before the device's shutdown restoration has run.
    writePipe(STDOUT_FILENO, output)
}
func pump(_ seconds: TimeInterval) {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
        _ = CFRunLoopRunInMode(.defaultMode, min(0.005, max(0.0001, deadline - ProcessInfo.processInfo.systemUptime)), true)
    } while ProcessInfo.processInfo.systemUptime < deadline
}
func hexColors(_ bytes: [UInt8]) -> [String] {
    stride(from: 0, to: bytes.count - 2, by: 3).map {
        String(format: "#%02x%02x%02x", bytes[$0], bytes[$0 + 1], bytes[$0 + 2])
    }
}
func parseColor(_ value: String) throws -> [UInt8] {
    let s = value.hasPrefix("#") ? String(value.dropFirst()) : value
    guard s.count == 6, s.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains($0) }),
          let number = UInt32(s, radix: 16) else {
        throw failure("INVALID_COLOR", "Colors must be six hexadecimal digits, for example #ff4080.")
    }
    return [UInt8((number >> 16) & 255), UInt8((number >> 8) & 255), UInt8(number & 255)]
}
func parseColors(_ value: Any?, count: Int) throws -> [UInt8] {
    guard let colors = value as? [String], colors.count == count else {
        throw failure("INVALID_COLORS", "colors must contain exactly \(count) strings in #rrggbb form.")
    }
    return try colors.flatMap(parseColor)
}

// Device profiles keep the USB identity, protocol schema and restoration
// namespace together. A Kick is never treated as an Air with fewer LEDs.
enum USBKeyboardModel: String, CaseIterable, Sendable {
    var defaultProductID: Int {
        switch self {
        case .air75: return 0x1028
        case .kick75: return 0x1026
        case .node75LP: return 0x1030
        case .node75HP: return 0x1031
        case .air65: return 0x102b
        case .air100: return 0x102d
        case .node100LP: return 0x1037
        case .node100HP: return 0x1036
        }
    }
    case air75 = "air75-v3", kick75 = "kick75"
    case node75LP = "node75-lp"
    case node75HP = "node75-hp"
    case node100LP = "node100-lp"
    case node100HP = "node100-hp"
    case air65 = "air65-v3"
    case air100 = "air100-v3"

    static let productIDs = [0x1028, 0x1026, 0x1027, 0x1030, 0x1031, 0x102b, 0x102d, 0x1037, 0x1036]
    static func identify(vendor: Int, product: Int) -> USBKeyboardModel? {
        guard vendor == 0x19f5 else { return nil }
        switch product { case 0x1028: return .air75; case 0x1026,0x1027: return .kick75;
        case 0x1030: return .node75LP
        case 0x1031: return .node75HP
        case 0x102b: return .air65
        case 0x102d: return .air100
        case 0x1037: return .node100LP
        case 0x1036: return .node100HP
        default: return nil }
    }
    var name: String { switch self { case .air75: return "Air75 V3 ANSI"; case .kick75: return "Kick75 ANSI";
        case .node75LP: return "NODE75 LP ANSI"
        case .node75HP: return "NODE75 HP ANSI"
        case .air65: return "Air65 V3 ANSI"
        case .air100: return "Air100 V3 ANSI"
        case .node100LP: return "NODE100 LP ANSI"
        case .node100HP: return "NODE100 HP ANSI"
    } }
    var keyCount: Int { switch self { case .air75: return 84; case .kick75: return 80; case .node75LP: return 84; case .node75HP: return 82; case .air65: return 68; case .air100: return 99; case .node100LP: return 103; case .node100HP: return 109 } }
    var sideCount: Int { switch self { case .air75: return 20; case .kick75: return 5; case .node75LP: return 5; case .node75HP: return 5; case .air65: return 20; case .air100: return 20; case .node100LP: return 5; case .node100HP: return 5 } }
    var rows: UInt8 { switch self { case .air75: return 6; case .kick75: return 6; case .node75LP: return 6; case .node75HP: return 6; case .air65: return 5; case .air100: return 6; case .node100LP: return 6; case .node100HP: return 6 } }
    var columns: UInt8 { switch self { case .air75: return 16; case .kick75: return 15; case .node75LP: return 16; case .node75HP: return 16; case .air65: return 15; case .air100: return 18; case .node100LP: return 19; case .node100HP: return 19 } }
    var extraKeys: Int { switch self { case .air75: return 2; case .kick75: return 2; case .node75LP: return 5; case .node75HP: return 5; case .air65: return 2; case .air100: return 2; case .node100LP: return 5; case .node100HP: return 5 } }
    // D2 returns matrix-scan order; D8 addresses the physical palette.
    // Exact tables come from each qualified firmware's initialized matrix map.
    var rgbWriteIndices:[Int] { switch self {
        case .node75LP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,59,58,57,56,55,54,53,52,51,50,49,48,47,46,60,61,62,63,64,65,66,67,68,69,70,71,72,73,83,82,81,80,79,78,77,76,75,74]
        case .node75HP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,58,57,56,55,54,53,52,51,50,49,48,47,46,45,59,60,61,62,63,64,65,66,67,68,69,70,71,72,81,80,79,78,77,76,75,74,73]
        case .node100LP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,37,36,35,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,73,72,71,70,69,68,67,66,65,64,63,62,61,60,59,58,57,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,102,101,100,99,98,97,96,95,94,93,92]
        case .node100HP: return [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,41,40,39,38,37,36,35,34,33,32,31,30,29,28,27,26,25,24,23,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,78,77,76,75,74,73,72,71,70,69,68,67,63,66,19,61,20,65,64,79,80,81,82,83,84,85,86,87,88,89,90,94,62,22,91,21,92,93,108,107,106,105,104,103,102,101,95,100,99,98,97,96]
        default: return Array(0..<keyCount)
    } }
    var canvasCount: Int { max(84,keyCount) }
    var totalCount: Int { keyCount + sideCount }
    var matrixKeyCount: Int { Int(rows) * Int(columns) }
    var keymapKeyCount: Int { matrixKeyCount + extraKeys }
    var globalPalette: Bool { self != .air75 }
    var protocolName: String { self == .air75 ? "air75-s4" : rawValue + "-s4" }
    var sideModeLimit: UInt8 { sideCount == 5 ? 3 : 4 }
    var qualifiedFirmware: String { switch self { case .air75: return "1.0.23.6"; case .kick75: return "4.0.18.6";
        case .node75LP: return "1.0.10.6"
        case .node75HP: return "1.0.10.6"
        case .air65: return "1.0.5.6"
        case .air100: return "1.0.6.6"
        case .node100LP: return "1.0.7.6"
        case .node100HP: return "1.0.7.6"
    } }
    var minimumFirmware: String { self == .air75 ? "1.0.16.6" : qualifiedFirmware }
    func hasQualifiedFirmware(_ firmware:[UInt8]) -> Bool {
        guard firmware.count == 8,firmware[3] == 0xaa,firmware[5] == 0 else { return false }
        return S4.firmwareVersion(firmware) == qualifiedFirmware
    }
    func supportsFunctionKeyAdaptation(_ firmware:[UInt8]) -> Bool {
        self != .air65 && S4.supportsPerKey(firmware,model:self)
    }
    func validGeometry(_ value: [UInt8]) -> Bool {
        value.count == 8 && value[0] <= 1 && Array(value[1...4]) == [8,4,rows,columns] &&
            (value[5] & 0x80 != 0 ? Int(value[5] & 0x7f) == extraKeys : extraKeys == 2)
    }
}

enum S4 {
    static let reportSize = 64
    // Air75 V3 D1 returns one byte. The following zero is unencrypted padding,
    // not a high byte: decoding it with key 0x80 turned 104 into 32872.
    static let ledCountLength = 1
    static let allowedCommands: Set<UInt8> = [0xa0, 0xa1, 0xb1, 0xb2, 0xb3, 0xd1, 0xd2, 0xd5, 0xd6, 0xd8, 0xf3, 0xf5]
    // NuPhyIO's Air75 V3 capability table: per-key mode starts at 1.0.16.6;
    // preset shapes extend D5/D6 from 17 to 22 bytes at 1.0.17.6. Keep minor
    // releases open, but require the same protocol family and read-only probes.
    static func stateLength(_ firmware: [UInt8], model: USBKeyboardModel = .air75) -> Int? {
        if model != .air75 && model != .kick75 { return model.hasQualifiedFirmware(firmware) ? 17 : nil }
        if model == .kick75 {
            guard firmware.count == 8, firmware[3] == 0xaa, firmware[2] == 4, firmware[1] == 0, [UInt8(15),18].contains(firmware[0]), firmware[4] == 6, firmware[5] == 0 else { return nil }
            return 17
        }
        guard firmware.count == 8, firmware[3] == 0xaa,
              firmware[2] == 1, firmware[4] == 6, firmware[5] == 0 else { return nil }
        return firmware[1] > 0 || firmware[0] >= 17 ? 22 : 17
    }
    static func supportsPerKey(_ firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        // Official 4.0.18.6 adds D8 and mode 21; 4.0.15.6 dispatches
        // D8 to UNKNOWN_COMMAND. Keep this independently qualified version
        // exact until another Kick firmware has been inspected and tested.
        if model != .air75 { return model.hasQualifiedFirmware(firmware) }
        return stateLength(firmware, model: model) != nil && (firmware[1] > 0 || firmware[0] >= 16)
    }
    static func renderedCustomByte(_ value: UInt8, index: Int, firmware: [UInt8], model: USBKeyboardModel = .air75) -> UInt8 {
        guard model == .air75, stateLength(firmware, model: model) == 22 else { return value }
        // 1.0.23.6's palette renderer (0x9bb0) uses HSV value capped at 200
        // (0xce80). The unlabelled final LED additionally scales green/blue.
        let scaled = Int(value) * 200 / 255
        return UInt8(index >= 250 ? scaled * 150 / 255 : scaled)
    }
    static func renderedCustomColors(_ colors: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> [UInt8] {
        colors.enumerated().map { renderedCustomByte($0.element, index: $0.offset, firmware: firmware, model: model) }
    }
    static func paletteFromRendered(_ colors: [UInt8], firmware: [UInt8], high: Bool = false, model: USBKeyboardModel = .air75) throws -> [UInt8] {
        try colors.enumerated().map { index, value in
            let candidates = (0...255).filter { renderedCustomByte(UInt8($0), index: index, firmware: firmware, model: model) == value }
            guard let input = high ? candidates.last : candidates.first else {
                throw failure("CUSTOM_BACKUP_LOSSY", "Cannot reconstruct the keyboard's custom palette; original state retained.")
            }
            return UInt8(input)
        }
    }
    static func validGeometry(_ value: [UInt8]) -> Bool {
        value.count == 8 && value[0] <= 1 && Array(value[1...4]) == [8,4,6,16] &&
            (value[5] & 0x80 == 0 || value[5] & 0x7f == 2)
    }
    static func validState(_ state: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), state.count == length else { return false }
        return state[0] <= (model == .kick75 ? (supportsPerKey(firmware,model:model) ? 21 : 20) : (length == 22 ? 22 : 21)) && state[1] <= 100 && state[2] <= 4 &&
            state[3] <= 3 && state[4] <= 1 && state[9] <= model.sideModeLimit && state[10] <= 100 &&
            state[11] <= 4 && state[12] <= 1 && (length == 17 || (state[17] <= 7 && state[21] <= 4))
    }
    static func readableState(_ state: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard stateLength(firmware, model: model) == 22, state.count == 22 else { return validState(state, firmware: firmware, model: model) }
        // NuPhyIO clamps the *read* shape-speed byte; some 1.0.23.6 boards
        // return e.g. 94 here. That is not a different packet schema. Retain
        // the raw byte in the journal, but never send it through the setter.
        var checked = state
        checked[21] = 0
        return validState(checked, firmware: firmware, model: model)
    }
    struct StateWriteSegment {
        let address: Int
        let payload: [UInt8]
    }
    static func stateWritePlan(_ target: [UInt8], current: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) throws -> [StateWriteSegment] {
        guard readableState(target, firmware: firmware, model: model), readableState(current, firmware: firmware, model: model) else {
            throw failure("INVALID_STATE", "Refusing an invalid lighting configuration.")
        }
        // NuPhyLab owns main/side fields 0...16. Preset fields 17...21
        // are never changed by this software, so never replay them from a
        // stale journal, even when they are valid setter values. Firmware or
        // another configurator may change these fields while USB is absent.
        var payload = Array(target.prefix(17))
        // 1.0.23.6 also mirrors the keyboard-owned preset shape at byte 5.
        // Retain its live value when committing the complete main/side prefix.
        if model == .air75, Array(firmware.prefix(6)) == [23,0,1,170,6,0] { payload[5] = current[5] }
        return [StateWriteSegment(address: 0, payload: payload)]
    }
    // 1.0.23.6 stores the main colour as byte HSV, with V scaled to 200.
    // D5 converts it back to RGB (official functions 0x4d92 / 0x4f16).
    // Feeding that RGB straight back into D6 can change the hue, e.g.
    // [64,0,14] -> [64,0,17]. Find an input whose readback is EXACTLY the
    // saved colour instead of weakening restore verification or accumulating drift.
    static func mainColorReadback(_ rgb: [UInt8]) -> [UInt8] {
        let r = Int(rgb[0]), g = Int(rgb[1]), b = Int(rgb[2])
        let hi = max(r,g,b), lo = min(r,g,b), delta = hi-lo
        let value = ((hi * 200 / 255) * 255 + 100) / 200
        if delta == 0 { return Array(repeating: UInt8(value), count: 3) }
        let saturation = Int(Float(delta) / Float(hi) * 255 + 0.5)
        var hue: Float
        if hi == r { hue = Float(g-b) / Float(delta) * 43 }
        else if hi == g { hue = (Float(b-r) / Float(delta) + 2) * 43 }
        else { hue = (Float(r-g) / Float(delta) + 4) * 43 }
        if hue < 0 { hue += 255 }
        let h = Int(hue + 0.5) & 255, region = h / 43, remainder = (h - region * 43) * 6
        let p = ((255-saturation) * value + 127) / 255
        let q = ((255-saturation * remainder / 255) * value + 127) / 255
        let t = ((255-saturation * (255-remainder) / 255) * value + 127) / 255
        let result: [Int]
        switch region {
        case 0: result = [value,t,p]
        case 1: result = [q,value,p]
        case 2: result = [p,value,t]
        case 3: result = [p,q,value]
        case 4: result = [t,p,value]
        default: result = [value,p,q]
        }
        return result.map(UInt8.init)
    }
    static func exactMainColorInput(_ target: [UInt8]) throws -> [UInt8] {
        if mainColorReadback(target) == target { return target }
        // Bound the search to one hue quantization interval plus value rounding.
        // A colour outside the proven model fails closed, keeping its journal.
        for radius in [4,8,16] {
            for r in max(0,Int(target[0])-radius)...min(255,Int(target[0])+radius) {
                for g in max(0,Int(target[1])-radius)...min(255,Int(target[1])+radius) {
                    for b in max(0,Int(target[2])-radius)...min(255,Int(target[2])+radius) {
                        let input = [UInt8(r),UInt8(g),UInt8(b)]
                        if mainColorReadback(input) == target { return input }
                    }
                }
            }
        }
        throw failure("RESTORE_COLOR_UNREPRESENTABLE", "Cannot exactly encode saved main colour \(target); original backup retained.")
    }
    static func statesMatch(_ expected: [UInt8], _ observed: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), expected.count == length, observed.count == length else { return false }
        // Official Air75 V3 1.0.16.6: both D6 dispatch tables skip offsets
        // 5 and 13; D5 leaves these palette-index slots unpopulated. They are
        // not restorable configuration. Every other byte remains strict.
        // The six additional qualified S4 firmwares allocate 17 bytes for D5
        // but never fill offsets 5/13; both D6 tables skip those entries.
        // They are heap residue, not configuration. Other bytes stay exact.
        let qualifiedAdditional = model != .air75 && model != .kick75 && model.hasQualifiedFirmware(firmware)
        let unusedPaletteSlots = (model == .air75 && Array(firmware.prefix(6)) == [0x10, 0, 1, 0xaa, 6, 0]) || qualifiedAdditional
        // 1.0.23.6 D5 now mirrors shape at offset 5, but still never populates
        // offset 13. Its D6 dispatch table skips 13 (official binary 0x44424).
        let unusedSidePalette = model == .air75 && Array(firmware.prefix(6)) == [23,0,1,0xaa,6,0]
        return expected.indices.allSatisfy {
            (unusedPaletteSlots && ($0 == 5 || $0 == 13)) || (unusedSidePalette && $0 == 13) || expected[$0] == observed[$0]
        }
    }
    static func ownedStateMatches(_ expected: [UInt8], _ observed: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard let length = stateLength(firmware, model: model), expected.count == length, observed.count == length else { return false }
        var ownedTarget = expected
        // The full comparator stays available for exact snapshot comparisons;
        // writes/restoration verify the fields this application actually owns.
        if length == 22 { ownedTarget.replaceSubrange(17..<22, with: observed[17..<22]) }
        if model == .air75, Array(firmware.prefix(6)) == [23,0,1,170,6,0] { ownedTarget[5] = observed[5] }
        return statesMatch(ownedTarget, observed, firmware: firmware, model: model)
    }
    static func presetFieldsDiffer(_ saved: [UInt8], _ current: [UInt8], firmware: [UInt8], model: USBKeyboardModel = .air75) -> Bool {
        guard stateLength(firmware, model: model) == 22, saved.count == 22, current.count == 22 else { return false }
        return saved.suffix(5) != current.suffix(5) ||
            (model == .air75 && Array(firmware.prefix(6)) == [23,0,1,170,6,0] && saved[5] != current[5])
    }
    static func checksum(_ bytes: [UInt8]) -> UInt8 {
        bytes.dropFirst(4).reduce(UInt8(0)) { $0 &+ $1 }
    }
    static func stateMismatchCode(expected: [UInt8], observed: [UInt8]) -> String {
        // A disabled board master switch ACKs D6 but skips its setter. Only
        // classify after delayed readback fails, never from zero brightness alone.
        let wantsLight = [17,22].contains(expected.count) && (expected[0] != 0 || expected[1] > 0 || expected[10] > 0)
        let staysOff = observed.count == expected.count && [17,22].contains(observed.count) && observed[0] == 0 && observed[1] == 0 && observed[10] == 0
        return wantsLight && staysOff ? "LIGHTING_DISABLED" : "STATE_VERIFY_FAILED"
    }
    static func restoreTarget(_ state: [UInt8]) -> [UInt8] {
        // D5 can expose mode 0 while the board's master switch is off, but D6
        // does not store mode 0. Restore its visible off state using stock
        // static mode at zero brightness; all remaining fields are preserved.
        guard [17,22].contains(state.count), state[0] == 0, state[1] == 0, state[10] == 0 else { return state }
        var target = state
        target[0] = 2
        return target
    }
    static func frame(command: UInt8, length: Int, address: Int = 0, payload: [UInt8] = [], handle: UInt8 = 0, key: UInt8) throws -> [UInt8] {
        guard allowedCommands.contains(command), (0...56).contains(length), payload.count <= 56,
              (0...65535).contains(address), payload.isEmpty || payload.count == length,
              handle == 0 || (handle == 1 && [0xd5,0xd6,0xd8].contains(command)) else {
            throw failure("INVALID_FRAME", "Command, length, or address is outside the bridge's allowlist.")
        }
        if command == 0xb3 {
            // One aligned function-key slot in the Mac base matrix. The caller
            // additionally requires its exact model, factory map and durable lease.
            let value=payload.count==2 ? Int(payload[0])<<8 | Int(payload[1]) : -1
            guard length == 2, address >= 0, address < 228, address % 2 == 0,
                  handle == 0, (58...69).contains(value) || [105,106,32262,32263,32264,32278,172,174,171,168,170,169].contains(value) else {
                throw failure("INVALID_FRAME", "Only journaled factory function-key leases are permitted.")
            }
        }
        // Inspected AIR 1.0.23.6: F3 is a board-global four-byte read;
        // F5 address 0 / length 1 changes only enable. Never expose the
        // official client's wider sleep-time setters or profile handles.
        if command == 0xf3 {
            guard length == 4, address == 0, payload.isEmpty, handle == 0 else {
                throw failure("INVALID_FRAME", "Only the four-byte board sleep read is permitted.")
            }
        }
        if command == 0xf5 {
            guard length == 1, address == 0, handle == 0, payload == [0] || payload == [1] else {
                throw failure("INVALID_FRAME", "Only the journaled board sleep enable flag may be written.")
            }
        }
        var bytes = [UInt8](repeating: 0, count: reportSize)
        bytes[0] = 0x55; bytes[1] = command
        bytes[4] = UInt8(length) ^ key
        bytes[5] = UInt8(address & 255) ^ key
        bytes[6] = UInt8(address >> 8) ^ key
        bytes[7] = handle ^ key // D5/D6 use the board's active Mac (0) / Win (1) profile.
        for (i, value) in payload.enumerated() { bytes[8 + i] = value ^ key }
        bytes[3] = checksum(bytes)
        return bytes
    }
    static func validate(_ raw: [UInt8], command: UInt8) throws {
        guard raw.count == reportSize, raw[0] == 0xaa, raw[1] == command, raw[2] == 0 else {
            throw failure("INVALID_REPLY", "HID response marker, command or report length did not match.")
        }
        guard raw[3] == checksum(raw) else { throw failure("INVALID_CHECKSUM", "HID response checksum did not match.") }
    }
    // Only reads may be retried. A failed write can already have reached the
    // keyboard; replaying it would silently overwrite a later user change.
    static func retryableProbe(_ error: Error) -> Bool {
        guard let error = error as? BridgeError else { return false }
        return ["HID_TIMEOUT", "HID_WRITE_FAILED", "INVALID_REPLY", "INVALID_CHECKSUM",
                "ROUTE_MISMATCH", "WRONG_LED_COUNT", "FIRMWARE_REPLY", "SESSION_CHANGED",
                "UNSUPPORTED_PROTOCOL"].contains(error.code)
    }
    static func decode(_ raw: [UInt8], command: UInt8, length: Int, address: Int = 0, handle: UInt8 = 0, key: UInt8) throws -> [UInt8] {
        try validate(raw, command: command)
        let route = [UInt8(length), UInt8(address & 255), UInt8(address >> 8), handle]
        let rawRoute = Array(raw[4..<8])
        guard rawRoute == route || rawRoute.map({ $0 ^ key }) == route else {
            throw failure("ROUTE_MISMATCH", "HID response route did not match; another configurator may own the session.")
        }
        return raw[8..<(8 + length)].map { $0 ^ key }
    }
    static func identify(_ raw: [UInt8]) throws -> (UInt8, [UInt8]) {
        try validate(raw, command: 0xa1)
        // The firmware-info marker is a constant AA in payload byte 3.
        // Accept either documented plaintext or XORed routing, without EE.
        let key = raw[11] ^ 0xaa
        let info = try decode(raw, command: 0xa1, length: 8, key: key)
        guard info[3] == 0xaa else { throw failure("FIRMWARE_REPLY", "Unrecognized firmware identification response.") }
        return (key, info)
    }
    static func firmwareVersion(_ info: [UInt8]) -> String {
        guard info.count == 8, info[3] == 0xaa else { return "unknown" }
        // NuPhyIO S4 parseFirmwareVersion: bytes 2.1.0, then little-endian 4–5.
        return "\(info[2]).\(info[1]).\(info[0]).\(Int(info[4]) | Int(info[5]) << 8)"
    }
    static func decodeLEDCount(_ raw: [UInt8], key: UInt8, expected: Int = 104) throws -> Int {
        let payload = try decode(raw, command: 0xd1, length: ledCountLength, key: key)
        let count = Int(payload[0])
        guard count == expected else {
            throw failure("WRONG_LED_COUNT", "灯位数量校验失败：应为 \(expected)，实际为 \(count)。已停止灯效写入。")
        }
        return count
    }
}

struct LightingBackup: Codable, Equatable {
    var schema = 1
    var createdAt: String
    var vendorID = 0x19f5
    var productID = 0x1028
    var serial: String
    var firmware: [UInt8]
    var state: [UInt8]
    var renderedColors: [UInt8]
    // New firmware persists D8's custom palette after an idle debounce. Keep
    // that palette even when the user was displaying a different stock effect.
    var customColors: [UInt8]? = nil
    // Old releases always addressed Mac profile 0, even when Win was active.
    var lightingProfile: UInt8? = nil
}

// Mac and Win have separate lighting configurations. Retain the inactive
// profile's journal until that profile is selected; never write it to the other.
struct LightingJournals: Sendable {
    let legacyURL: URL
    var model: USBKeyboardModel = .air75
    var productID: Int = 0x1028
    func url(_ profile: UInt8) -> URL {
        legacyURL.deletingPathExtension().appendingPathExtension("profile-\(profile).json")
    }
    var profiles: [UInt8] { [UInt8(0), 1].filter { FileManager.default.fileExists(atPath: url($0).path) } }
    var hasLegacy: Bool { FileManager.default.fileExists(atPath: legacyURL.path) }
    func read(_ url: URL, serial: String) throws -> LightingBackup {
        do {
            let record = try JSONDecoder().decode(LightingBackup.self, from: Data(contentsOf: url))
            guard record.schema == 1, record.vendorID == 0x19f5, record.productID == productID,
                  S4.readableState(record.state, firmware: record.firmware, model: model), record.renderedColors.count == model.totalCount * 3,
                  record.customColors == nil || record.customColors?.count == model.keyCount * 3,
                  (record.lightingProfile ?? 0) <= 1 else {
                throw failure("INVALID_BACKUP", "The lighting backup has an invalid schema or size.")
            }
            if !record.serial.isEmpty && !serial.isEmpty && record.serial != serial {
                throw failure("BACKUP_DEVICE_MISMATCH", "The pending backup belongs to a different keyboard serial number.")
            }
            return record
        } catch let error as BridgeError { throw error }
        catch { throw failure("BACKUP_READ_FAILED", "Cannot read the existing lighting backup: \(error.localizedDescription)") }
    }
    func migrateLegacy(serial: String) throws {
        guard hasLegacy else { return }
        let record = try read(legacyURL, serial: serial)
        let destination = url(record.lightingProfile ?? 0)
        // moveItem refuses to overwrite an existing journal. On a conflict,
        // retain both originals instead of choosing one and losing recovery.
        do { try FileManager.default.moveItem(at: legacyURL, to: destination) }
        catch { throw failure("BACKUP_MIGRATION_FAILED", "无法整理灯光恢复记录，原始备份已保留。") }
    }
    func archiveBeforeFirmwareChange(_ record: LightingBackup, serial: String) throws -> URL {
        let source = url(record.lightingProfile ?? 0)
        // Validate the durable original again; never discard or overwrite it.
        let durable = try read(source, serial: serial)
        guard durable.firmware == record.firmware else {
            throw failure("INVALID_BACKUP", "The recovery record changed during firmware migration.")
        }
        let directory = source.deletingLastPathComponent().appendingPathComponent("firmware-recovery-history")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let destination = directory.appendingPathComponent("\(source.deletingPathExtension().lastPathComponent)-\(S4.firmwareVersion(record.firmware))-\(UUID().uuidString).json")
        try FileManager.default.moveItem(at: source, to: destination)
        return destination
    }
    func preservePresetHistory(_ record: LightingBackup, serial: String) throws -> URL {
        let source = url(record.lightingProfile ?? 0)
        let durable = try read(source, serial: serial)
        guard durable == record else {
            throw failure("INVALID_BACKUP", "The original recovery record changed before archival.")
        }
        let bytes = try Data(contentsOf: source)
        guard try JSONDecoder().decode(LightingBackup.self, from: bytes) == record else {
            throw failure("INVALID_BACKUP", "The original recovery record changed during archival.")
        }
        let directory = source.deletingLastPathComponent().appendingPathComponent("preset-recovery-history")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // A failed retry must not produce unlimited identical history copies.
        for existing in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where existing.pathExtension == "json" && existing.lastPathComponent.hasPrefix(source.deletingPathExtension().lastPathComponent + "-") {
            if (try? Data(contentsOf: existing)) == bytes { return existing.resolvingSymlinksInPath() }
        }
        let destination = directory.appendingPathComponent("\(source.deletingPathExtension().lastPathComponent)-\(UUID().uuidString).json")
        try bytes.write(to: destination, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        let handle = try FileHandle(forWritingTo: destination)
        do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
        guard try Data(contentsOf: destination) == bytes else {
            throw failure("BACKUP_SAVE_FAILED", "The original recovery archive did not verify; active backup retained.")
        }
        return destination.resolvingSymlinksInPath()
    }
    func saveCustomColors(_ colors: [UInt8], record: LightingBackup, serial: String) throws -> LightingBackup {
        guard colors.count == model.keyCount * 3 else { throw failure("INVALID_BACKUP", "Invalid custom palette size.") }
        let source = url(record.lightingProfile ?? 0)
        let original = try read(source, serial: serial)
        guard original.createdAt == record.createdAt, original.firmware == record.firmware,
              original.state == record.state else { throw failure("INVALID_BACKUP", "The recovery record changed before palette capture.") }
        var updated = original; updated.customColors = colors
        let temporary = source.appendingPathExtension(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(updated).write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let handle = try FileHandle(forWritingTo: temporary)
        do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
        guard Darwin.rename(temporary.path, source.path) == 0 else { throw failure("BACKUP_SAVE_FAILED", "Cannot preserve the original custom palette; no RGB frame was sent.") }
        return updated
    }
}

struct FunctionKeyAssignment: Codable, Equatable, Sendable {
    let position: Int
    let target: Int
}
struct FunctionKeyBackup: Codable, Equatable {
    let firmware: [UInt8]
    let serial: String
    let locationId: Int
    let position: Int
    let original: [Int]
    // Optional fields preserve decoding of legacy AIR-only schema-1 leases.
    // A metadata-free record is always AIR; it can never restore to Kick.
    var modelId: String? = nil
    var productID: Int? = nil
    var keymapKeyCount: Int? = nil
    // Schema extension for qualified NODE/AIR models with shared media inputs.
    // Original records without this field remain the single F4 lease.
    var leased: [FunctionKeyAssignment]? = nil
    var assignments: [FunctionKeyAssignment] { leased ?? [FunctionKeyAssignment(position:position,target:61)] }
}

// Sleep enable is board-global, unlike the two independent RGB profiles.
// Keep its original separately so profile changes cannot replace its baseline.
struct BoardSleepBackup: Codable, Equatable, Sendable {
    var schema = 1
    var createdAt: String
    var vendorID = 0x19f5
    var productID = 0x1028
    var serial: String
    var firmware: [UInt8]
    var original: [UInt8]
    var installedEnable: UInt8 = 0
}

struct BoardSleepJournal: Sendable {
    let url: URL
    var exists: Bool { FileManager.default.fileExists(atPath: url.path) }
    // A retained journal can be validated while no keyboard is attached. Device
    // matching is a separate prerequisite for every actual read/write lease.
    func readRetained() throws -> BoardSleepBackup {
        let saved: BoardSleepBackup
        do { saved = try JSONDecoder().decode(BoardSleepBackup.self, from: Data(contentsOf: url)) }
        catch { throw failure("SLEEP_BACKUP_INVALID", "The original board sleep record cannot be read; it has been retained.") }
        guard saved.schema == 1, !saved.createdAt.isEmpty, saved.vendorID == 0x19f5, saved.productID == 0x1028,
              saved.firmware.count == 8, Array(saved.firmware.prefix(6)) == [23,0,1,170,6,0],
              saved.original.count == 4, saved.original[0] <= 1, saved.installedEnable == 0,
              !saved.serial.isEmpty else {
            throw failure("SLEEP_BACKUP_INVALID", "The original board sleep record has an invalid identity or schema; it has been retained.")
        }
        return saved
    }
    func read(serial: String, firmware: [UInt8]) throws -> BoardSleepBackup {
        let saved = try readRetained()
        guard !serial.isEmpty, saved.serial == serial else {
            throw failure("SLEEP_BACKUP_DEVICE_MISMATCH", "The board sleep record belongs to a different keyboard. No sleep setting was written.")
        }
        guard firmware.count == 8, Array(saved.firmware.prefix(6)) == Array(firmware.prefix(6)) else {
            throw failure("SLEEP_BACKUP_FIRMWARE_MISMATCH", "The firmware differs from the board sleep record. No sleep setting was written.")
        }
        return saved
    }
    private func writeNew(_ data: Data, to destination: URL) throws {
        let directory = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".sleep-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let file = try FileHandle(forWritingTo: temporary)
        do { try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
        // link is an atomic no-replace publication: never replace an original
        // that appeared after the initial existence check.
        guard Darwin.link(temporary.path, destination.path) == 0 else {
            throw failure("SLEEP_BACKUP_SAVE_FAILED", "Cannot safely publish the original board sleep record; no sleep setting was written.")
        }
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw failure("SLEEP_BACKUP_SAVE_FAILED", "Cannot sync the board sleep record directory.") }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0, try Data(contentsOf: destination) == data else {
            throw failure("SLEEP_BACKUP_SAVE_FAILED", "The durable board sleep record did not verify; it has been retained.")
        }
    }
    func save(_ record: BoardSleepBackup) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try writeNew(encoder.encode(record), to: url)
    }
    func archive(_ record: BoardSleepBackup) throws -> URL {
        guard try read(serial: record.serial, firmware: record.firmware) == record else {
            throw failure("SLEEP_BACKUP_CHANGED", "The original board sleep record changed; it has been retained.")
        }
        let bytes = try Data(contentsOf: url)
        guard try JSONDecoder().decode(BoardSleepBackup.self, from: bytes) == record else {
            throw failure("SLEEP_BACKUP_CHANGED", "The original board sleep record changed before archival.")
        }
        let directory = url.deletingLastPathComponent().appendingPathComponent("board-sleep-recovery-history")
        let destination = directory.appendingPathComponent("board-sleep-\(UUID().uuidString).json")
        try writeNew(bytes, to: destination)
        return destination
    }
}

final class Air75Device {
    private let baseBackupURL: URL
    private(set) var model: USBKeyboardModel = .air75
    private(set) var productID: Int = 0x1028
    var productId: Int { productID }
    var modelName: String { model.name }
    var transportMode: String { "USB" }
    var isDongle: Bool { false }
    var journals: LightingJournals {
        let base: URL
        if model == .air75 { base = baseBackupURL }
        else {
            let identity = journalIdentity
            base = baseBackupURL.deletingLastPathComponent().appendingPathComponent("devices/\(model.rawValue)-\(String(productID,radix:16))-\(identity)").appendingPathComponent(baseBackupURL.lastPathComponent)
        }
        return LightingJournals(legacyURL: base, model: model, productID: productID)
    }
    var keyLedCount: Int { model.keyCount }
    var customColorScale: Int { model == .air75 && S4.stateLength(firmware, model: model) == 22 ? 200 : 255 }
    var backupURL: URL { journals.url(lightingProfile) }
    var functionKeyBackupURL: URL { journals.legacyURL.deletingLastPathComponent().appendingPathComponent("function-key-backup.json") }
    var boardSleepJournal: BoardSleepJournal { BoardSleepJournal(url: baseBackupURL.deletingLastPathComponent().appendingPathComponent("board-sleep-backup.json")) }
    private var locationId: Int { testExchange == nil ? device.flatMap { propertyInt($0,kIOHIDLocationIDKey) } ?? 0 : testLocation?() ?? 1 }
    var hasFunctionKeyBackup: Bool { FileManager.default.fileExists(atPath:functionKeyBackupURL.path) }
    private var manager: IOHIDManager?
    private var lockFD: Int32 = -1
    private var device: IOHIDDevice?
    private var inputBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    private var replies = [[UInt8]]()
    private var removed = false
    private var key: UInt8 = 0
    private var lightingProfile: UInt8 = 0
    private var serial = ""
    private var journalIdentity = "unidentified"
    private var backup: LightingBackup?
    private var mutationAttempted = false
    private var functionKeyMutationAttempted = false
    private var sleepMutationAttempted = false
    private var sleepLeaseGeneration: UInt64?
    private var sleepLeaseOriginal: BoardSleepBackup?
    private var firstPaintVerified = false
    private var lastPaint: [UInt8]?
    private var lastRGBWriteAt: TimeInterval?
    private var protocolReady = false
    private var identified = false
    private var compatibilityError: BridgeError?
    private var keyRecoveryError: BridgeError?
    private var connectionGeneration: UInt64 = 0
    private var functionKeyOwnerConnection: UInt64?
    private struct FunctionKeyRecoveryPreview {
        let token: String
        let journal: Data
        let saved: FunctionKeyBackup
        let mac: [Int]
        let firmware: [UInt8]
        let serial: String
        let location: Int
        let generation: UInt64
        let action: String
    }
    private var functionKeyRecoveryPreview: FunctionKeyRecoveryPreview?
    private var ownsCurrentFunctionKeyLease: Bool { functionKeyMutationAttempted && functionKeyOwnerConnection == connectionGeneration }
    var keyRecovery: [String:Any] {
        let pending = hasFunctionKeyBackup || functionKeyMutationAttempted
        let lost=hasLostFunctionKeyRecovery
        let active = pending && connected && ownsCurrentFunctionKeyLease && keyRecoveryError == nil
        let status = !pending ? "none" : lost ? "blocked" : active ? "active" : keyRecoveryError.map { ["KEY_LEASE_CONFIRMATION_REQUIRED","KEY_LEASE_DEVICE"].contains($0.code) ? "confirmationRequired" : "blocked" } ?? "confirmationRequired"
        let code:Any,message:Any
        if lost {code="KEY_LEASE_BACKUP";message="本进程曾修改 F4，但原恢复记录缺失，无法确认恢复；已停止后续键位修改。"}
        else if let error=keyRecoveryError {code=error.code;message=error.message}
        else if pending && !active {code="KEY_LEASE_CONFIRMATION_REQUIRED";message="检测到上次功能键适配记录，请确认当前仍是原键盘后恢复。其他功能可继续使用。"}
        else {code=NSNull();message=NSNull()}
        return ["status":status,"pending":pending,"blocking":pending && !active,"ownsCurrentHandle":ownsFunctionKeyChanges,
                "unownedHistory":pending && !ownsCurrentFunctionKeyLease && !lost,
                "requiresSameKeyboardConfirmation":pending && !active && !lost,
                "errorCode":code,"error":message]
    }
    // In-process self-tests can exercise the complete session lifecycle without
    // opening IOKit. No JSON command or environment variable enables this seam.
    private let testExchange: (([UInt8]) throws -> [UInt8])?
    private let testLocation: (() -> Int)?
    private let testSerial: (() -> String)?
    private let testUptime: (() -> TimeInterval)?
    private var functionKeyDeadline: TimeInterval?
    private var transactionUptime: TimeInterval {testUptime?() ?? ProcessInfo.processInfo.systemUptime}
    private var testConnected = false
    private(set) var firmware = [UInt8]()
    private(set) var ledCount = 0
    private(set) var armed = false
    var connected: Bool { (testExchange == nil ? device != nil : testConnected) && !removed }
    var controlReady: Bool { connected && protocolReady }
    var ownsChanges: Bool { mutationAttempted }
    var ownsFunctionKeyChanges: Bool { connected && ownsCurrentFunctionKeyLease }
    var hasLostFunctionKeyRecovery: Bool { functionKeyMutationAttempted && !hasFunctionKeyBackup }
    var recoveryPending: Bool { backup != nil || journals.hasLegacy || FileManager.default.fileExists(atPath: backupURL.path) }
    var deferredProfiles: [UInt8] { journals.profiles.filter { $0 != lightingProfile } }
    var hasPendingBackups: Bool { recoveryPending || !deferredProfiles.isEmpty }
    var boardSleepLeasePending: Bool { (model == .air75 && boardSleepJournal.exists) || sleepMutationAttempted }
    var supportsBoardSleepLease: Bool { model == .air75 && supportsConnectionWake && !serial.isEmpty }
    private var boardSleepLeaseStatus: [String: Any] {
        ["supported":supportsBoardSleepLease,"active":connected && sleepLeaseGeneration == connectionGeneration && boardSleepLeasePending,
         "pending":boardSleepLeasePending,"ownsChanges":sleepMutationAttempted,
         "backupPath":boardSleepJournal.url.path]
    }

    convenience init(backupURL: URL, testProductId: Int, testExchange: (([UInt8]) throws -> [UInt8])? = nil) {
        let testModel = USBKeyboardModel.identify(vendor: 0x19f5, product: testProductId) ?? .air75
        self.init(backupURL: backupURL, testModel: testModel, testExchange: testExchange)
    }

    init(backupURL: URL, testModel: USBKeyboardModel = .air75, testLocation: (() -> Int)? = nil, testSerial: (() -> String)? = nil, testUptime: (() -> TimeInterval)? = nil, testExchange: (([UInt8]) throws -> [UInt8])? = nil) {
        baseBackupURL = backupURL
        model = testModel; productID = [USBKeyboardModel.air75:0x1028,.kick75:0x1026,.node75LP:0x1030,.node75HP:0x1031,.node100LP:0x1037,.node100HP:0x1036,.air65:0x102b,.air100:0x102d][testModel]!
        self.testExchange = testExchange; self.testLocation = testLocation; self.testSerial = testSerial; self.testUptime = testUptime
    }
    deinit { closeTransport(); inputBuffer.deallocate() }

    func receive(_ report: UnsafeMutablePointer<UInt8>, count: Int, result: IOReturn, reportID: UInt32) {
        guard result == kIOReturnSuccess, count == 64, reportID == 0 else { return }
        replies.append(Array(UnsafeBufferPointer(start: report, count: count)))
        if replies.count > 64 { replies.removeFirst(replies.count - 64) }
    }
    func didRemove() {
        removed = true; armed = false
        emit(["event": "disconnected", "needsRestore": recoveryPending,
              "message": "Keyboard disconnected; its lighting backup has been retained."])
    }
    private func propertyInt(_ device: IOHIDDevice, _ name: String) -> Int? {
        (IOHIDDeviceGetProperty(device, name as CFString) as? NSNumber)?.intValue
    }
    private func requireConnected() throws {
        guard connected else { throw failure("NOT_CONNECTED", "Connect Air75 V3 or Kick75 by USB first.") }
    }
    private func adoptConnectionIdentity(_ nextModel:USBKeyboardModel,_ nextProduct:Int,_ nextSerial:String,_ nextLocation:Int) {
        let nextIdentity = nextSerial.isEmpty ? "location-\(nextLocation)" : nextSerial.utf8.map { String(format:"%02x",$0) }.joined()
        if nextProduct != productID || nextSerial != serial || nextIdentity != journalIdentity {
            // Keep the old namespace on disk, but never carry its in-memory
            // ownership into another namespace (including empty-serial ports).
            backup=nil;mutationAttempted=false;functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil
            firstPaintVerified=false;lastPaint=nil;firmware=[];keyRecoveryError=nil
            sleepMutationAttempted=false;sleepLeaseGeneration=nil;sleepLeaseOriginal=nil
        }
        model=nextModel;productID=nextProduct;serial=nextSerial;journalIdentity=nextIdentity
        connectionGeneration += 1
    }
    private func openTransport() throws {
        guard !hasLostFunctionKeyRecovery else {throw failure("KEY_LEASE_BACKUP","本进程修改过 F4，但原恢复记录缺失，无法确认恢复；已停止重新连接。")}
        closeTransport()
        if testExchange != nil {
            let nextSerial = testSerial?() ?? "self-test"
            adoptConnectionIdentity(model,productID,nextSerial,testLocation?() ?? 1)
            testConnected=true;return
        }
        lockFD = Darwin.open("/tmp/air75-studio-hid-\(getuid()).lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
            throw failure("HID_IN_USE", "Another Air75 Studio helper already owns the keyboard connection.")
        }
        let m = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matches = USBKeyboardModel.productIDs.map { product in
            [kIOHIDVendorIDKey: 0x19f5, kIOHIDProductIDKey: product, kIOHIDTransportKey:"USB",
             kIOHIDPrimaryUsagePageKey: 1, kIOHIDPrimaryUsageKey: 0] as [String:Any]
        }
        IOHIDManagerSetDeviceMatchingMultiple(m, matches as CFArray)
        // Matching enumerates without opening HID (as in Bluetooth discovery).
        // Frequent absent-device checks must not open/close every HID interface
        // or register input callbacks. Open only after one candidate is found.
        guard let all = IOHIDManagerCopyDevices(m) as? Set<IOHIDDevice> else {
            closeTransport(); throw failure("DEVICE_NOT_FOUND", "等待键盘连接：请连接支持的 NuPhy 键盘，并切到有线模式。")
        }
        let candidates = all.filter {
            USBKeyboardModel.identify(vendor: propertyInt($0, kIOHIDVendorIDKey) ?? 0, product: propertyInt($0, kIOHIDProductIDKey) ?? 0) != nil &&
            propertyInt($0, kIOHIDPrimaryUsagePageKey) == 1 && propertyInt($0, kIOHIDPrimaryUsageKey) == 0 &&
            propertyInt($0, kIOHIDMaxInputReportSizeKey) == 64 && propertyInt($0, kIOHIDMaxOutputReportSizeKey) == 64
        }
        guard !candidates.isEmpty else {
            closeTransport(); throw failure("DEVICE_NOT_FOUND", "等待键盘连接：请连接支持的 NuPhy 键盘，并切到有线模式。")
        }
        guard candidates.count == 1, let selected = candidates.first else {
            closeTransport()
            throw failure("DEVICE_AMBIGUOUS", "检测到多把支持的键盘，请仅用数据线连接要使用的一把。")
        }
        manager = m
        IOHIDManagerScheduleWithRunLoop(m, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        let opened = IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeNone))
        guard opened == kIOReturnSuccess else {
            closeTransport()
            throw failure("HID_PERMISSION", "Cannot open the vendor HID interface (\(String(format: "0x%08x", opened))). Check Input Monitoring and close NuPhyIO.")
        }
        let nextProduct = propertyInt(selected,kIOHIDProductIDKey) ?? 0
        let nextModel = USBKeyboardModel.identify(vendor: 0x19f5, product: nextProduct)!
        let nextSerial = IOHIDDeviceGetProperty(selected, kIOHIDSerialNumberKey as CFString) as? String ?? ""
        adoptConnectionIdentity(nextModel,nextProduct,nextSerial,propertyInt(selected,kIOHIDLocationIDKey) ?? 0)
        device=selected;removed=false
        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(selected, inputBuffer, 64, { context, result, _, _, reportID, report, count in
            guard let context = context else { return }
            Unmanaged<Air75Device>.fromOpaque(context).takeUnretainedValue().receive(report, count: count, result: result, reportID: reportID)
        }, context)
        IOHIDDeviceRegisterRemovalCallback(selected, { context, _, _ in
            guard let context = context else { return }
            Unmanaged<Air75Device>.fromOpaque(context).takeUnretainedValue().didRemove()
        }, context)
        pump(0.02)
    }
    private func closeTransport() {
        if let d = device {
            IOHIDDeviceRegisterInputReportCallback(d, inputBuffer, 64, nil, nil)
            IOHIDDeviceRegisterRemovalCallback(d, nil, nil)
        }
        if let m = manager {
            IOHIDManagerUnscheduleFromRunLoop(m, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
            IOHIDManagerClose(m, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        device = nil; manager = nil; replies.removeAll(); removed = false; armed = false; lastRGBWriteAt = nil; protocolReady = false
        identified = false; compatibilityError = nil; functionKeyRecoveryPreview = nil
        testConnected = false
        if lockFD >= 0 { flock(lockFD, LOCK_UN); Darwin.close(lockFD); lockFD = -1 }
    }
    private func exchange(_ frame: [UInt8], timeout: TimeInterval = 0.65) throws -> [UInt8] {
        try requireConnected()
        func remainingBudget() throws -> TimeInterval {
            guard let deadline=functionKeyDeadline else {return timeout}
            let remaining=deadline-transactionUptime
            guard remaining>0 else {throw failure("KEY_LEASE_TIMEOUT","功能键操作已超时，原键位记录已保留；未继续修改键盘。")}
            return min(timeout,remaining)
        }
        _ = try remainingBudget()
        if let testExchange = testExchange {
            let reply=try testExchange(frame)
            _ = try remainingBudget()
            return reply
        }
        guard let d = device else { throw failure("NOT_CONNECTED", "Connect Air75 V3 or Kick75 by USB first.") }
        // Flush already delivered reports. Never resend an uncertain write or
        // send undocumented opcodes to unstick a desynchronized session.
        pump(0.001)
        replies.removeAll(keepingCapacity: true)
        let frameBudget=try remainingBudget()
        // Count the synchronous send against this frame and the whole command.
        // Starting a new wait after SetReport would renew a nearly spent budget.
        let deadline = ProcessInfo.processInfo.systemUptime + frameBudget
        let sent = frame.withUnsafeBufferPointer {
            IOHIDDeviceSetReport(d, kIOHIDReportTypeOutput, CFIndex(0), $0.baseAddress!, 64)
        }
        _ = try remainingBudget()
        guard sent == kIOReturnSuccess else {
            throw failure("HID_WRITE_FAILED", "HID output failed (\(String(format: "0x%08x", sent))); reconnect the cable and close other lighting apps.")
        }
        while ProcessInfo.processInfo.systemUptime < deadline {
            if removed { throw failure("DISCONNECTED", "Keyboard unplugged during a transaction; backup retained.") }
            while !replies.isEmpty {
                let reply = replies.removeFirst()
                guard reply.count == 64, reply[0] == 0xaa, reply[1] == frame[1] else { continue }
                // Ignore stale or unrelated replies until this transaction's
                // deadline. D2/B2 chunks share opcodes but have different routes.
                do {
                    try S4.validate(reply, command: frame[1])
                    if frame[1] != 0xa1 {
                        _ = try S4.decode(reply, command: frame[1], length: Int(frame[4] ^ key),
                                          address: Int(frame[5] ^ key) | Int(frame[6] ^ key) << 8,
                                          handle: frame[7] ^ key, key: key)
                    }
                } catch { diagnostic("Ignored unmatched HID reply: \(error)");continue }
                // Late success is also a timeout. Keep this outside the
                // malformed-reply catch so it cannot be ignored or renewed.
                _ = try remainingBudget()
                guard ProcessInfo.processInfo.systemUptime < deadline else {break}
                return reply
            }
            _ = CFRunLoopRunInMode(.defaultMode, 0.002, true)
        }
        _ = try remainingBudget()
        throw failure("HID_TIMEOUT", "No valid \(String(format: "%02X", frame[1])) response. Stop other HID clients and reconnect; no blind write retry was performed.")
    }
    private func request(_ command: UInt8, length: Int, address: Int = 0, payload: [UInt8] = []) throws -> [UInt8] {
        if [UInt8(0xb3),0xd6,0xd8,0xf5].contains(command), !protocolReady {
            throw compatibilityError ?? failure("UNSUPPORTED_PROTOCOL", "键盘尚未通过兼容性检查，未修改任何键盘设置。请先通过 NuPhyIO 检查固件。")
        }
        if [UInt8(0xf3),0xf5].contains(command), !supportsBoardSleepLease {
            throw failure("SLEEP_UNSUPPORTED", "Board sleep control is available only for a verified Air75 V3 1.0.23.6 with a nonempty serial.")
        }
        let handle = [UInt8(0xd5),0xd6,0xd8].contains(command) ? lightingProfile : 0
        let frame = try S4.frame(command: command, length: length, address: address, payload: payload, handle: handle, key: key)
        let raw = try exchange(frame)
        return try S4.decode(raw, command: command, length: length, address: address, handle: handle, key: key)
    }
    private func refreshLightingProfile() throws {
        let geometry = try request(0xa0, length: 8)
        guard model.validGeometry(geometry) else {
            diagnostic("Geometry probe \(model.rawValue): \(geometry)")
            throw failure("UNSUPPORTED_PROTOCOL", "正在重新连接键盘，请稍候。")
        }
        lightingProfile = geometry[0]
    }
    private func verifyLightingProfileForWrite() throws {
        try refreshLightingProfile()
        if let saved = backup, Array(saved.firmware.prefix(6)) != Array(firmware.prefix(6)) {
            armed = false
            throw failure("BACKUP_FIRMWARE_MISMATCH", "固件与恢复记录不一致，已保留备份并停止写入。请重新连接键盘。")
        }
        if let saved = backup, (saved.lightingProfile ?? 0) != lightingProfile {
            armed = false
            throw failure("LIGHTING_PROFILE_CHANGED", "键盘档位已改变，请重新播放灯效。")
        }
    }
    private func selectRecoveryProfile(reconnected: Bool = false) throws {
        try journals.migrateLegacy(serial: serial)
        if let saved = backup, (saved.lightingProfile ?? 0) != lightingProfile {
            // The old profile's durable journal stays on disk. Drop only the
            // live ownership, so a new session can use its own profile safely.
            backup = nil; mutationAttempted = false; armed = false
            firstPaintVerified = false; lastPaint = nil
        }
        if backup == nil, FileManager.default.fileExists(atPath: backupURL.path) {
            backup = try loadBackup()
        }
        if let saved = backup, Array(saved.firmware.prefix(6)) != Array(firmware.prefix(6)) {
            guard protocolReady, !mutationAttempted || reconnected else {
                throw failure("BACKUP_FIRMWARE_MISMATCH", "固件与恢复记录不一致，已保留备份并停止写入。请重新连接键盘。")
            }
            // Firmware updates can change the configuration schema. Keep the
            // old journal as history instead of writing old settings into the
            // new firmware. Its currently read settings become the new baseline.
            let archived = try journals.archiveBeforeFirmwareChange(saved, serial: serial)
            diagnostic("Prior firmware recovery record preserved at \(archived.path)")
            backup = nil; mutationAttempted = false; armed = false
            firstPaintVerified = false; lastPaint = nil; lastRGBWriteAt = nil
        }
    }
    private func readIdentity() throws {
        let initial = try S4.frame(command: 0xa1, length: 8, key: 0)
        let raw = try exchange(initial)
        let (newKey, newFirmware) = try S4.identify(raw)
        // Trailing A1 bytes are reserved/session data, not the firmware version.
        if Array(firmware.prefix(6)) != Array(newFirmware.prefix(6)) { protocolReady = false }
        key = newKey; firmware = newFirmware
        identified = true
    }
    private func identify() throws {
        try readIdentity()
        do {try verifyLEDCount()} catch {protocolReady=false;throw error}
    }
    private func verifyLEDCount() throws {
        let countFrame = try S4.frame(command: 0xd1, length: S4.ledCountLength, key: key)
        let reply=try exchange(countFrame)
        // Retain the observed count for diagnostics, never as permission to
        // paint it. The expected model-specific total must still validate.
        ledCount=Int(try S4.decode(reply,command:0xd1,length:S4.ledCountLength,key:key)[0])
        _ = try S4.decodeLEDCount(reply,key:key,expected:model.totalCount)
    }
    func connect() throws -> [String: Any] {
        if !connected {
            try openTransport()
        }
        // A separate configurator may have changed the in-RAM session key.
        // Refresh it using read-only A1 rather than mutating the key with EE.
        // A1 identity/firmware discovery must remain available when an older
        // firmware cannot pass the lighting route. No writes are enabled here.
        do { try readIdentity() } catch { closeTransport(); throw error }
        protocolReady = false; compatibilityError = nil;ledCount=0
        var state = [UInt8]()
        var probeFailure: Error?
        for attempt in 0..<3 {
            do {
                if attempt > 0 { pump(0.08 * Double(attempt)); try readIdentity() }
                let probeKey = key, probeFirmware = Array(firmware.prefix(6))
                try verifyLEDCount()
                state = try readState()
                _ = try readRGB() // Validate the complete D2 route before allowing writes.
                try readIdentity()
                guard key == probeKey, Array(firmware.prefix(6)) == probeFirmware else {
                    throw failure("SESSION_CHANGED", "键盘连接正在恢复，请稍候。")
                }
                protocolReady = true; probeFailure = nil; break
            } catch {
                probeFailure = error
                diagnostic("Read-only connection probe \(attempt + 1) failed: \(error)")
                if !connected || !S4.retryableProbe(error) { break }
            }
        }
        if let error = probeFailure {
            protocolReady = false; armed = false
            compatibilityError = (error as? BridgeError) ?? failure("PROTOCOL_PROBE_FAILED", error.localizedDescription)
            return connectionSnapshot()
        }
        // A successfully reprobed firmware is a new lighting session even if
        // this helper controlled the pre-upgrade firmware. Retire that ownership
        // only here, after A1/A0/D1/D5/D2 all validate; status/restore still block.
        do { try selectRecoveryProfile(reconnected: true) }
        catch {
            protocolReady = false; armed = false
            compatibilityError = (error as? BridgeError) ?? failure("RECOVERY_CHECK_FAILED", error.localizedDescription)
            return connectionSnapshot()
        }
        // An old F4 record is independent of the validated RGB protocol. A
        // changed USB attachment must not silently claim another physical board.
        keyRecoveryError = nil
        if hasFunctionKeyBackup {
            do {
                // An already-original map needs no recovery write or physical
                // identity claim. Retire only that exact, read-verified record.
                if !ownsCurrentFunctionKeyLease { _ = try archiveObservedOriginalFunctionKeyHistory() }
                if hasFunctionKeyBackup { _ = try restoreFunctionKey() }
            }
            catch { keyRecoveryError = (error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription) }
        }
        var result=connectionSnapshot(state:state)
        result["originalState"]=state
        return result
    }
    private var capabilities: [String: Any] {
        ["perKey": protocolReady && S4.supportsPerKey(firmware, model: model), "sideWholeZone": protocolReady,
         "sidePixels": false, "mainWholeZone": protocolReady, "stockEffects": protocolReady && model == .kick75, "perKeyFirmwareRequired": model.minimumFirmware, "functionKeyAdaptation": protocolReady && model.supportsFunctionKeyAdaptation(firmware), "protocol": model.protocolName, "stateBytes": S4.stateLength(firmware, model: model) ?? 0,
         "readProbeVerified": protocolReady, "connectionWake": supportsConnectionWake,"boardSleepLease":supportsBoardSleepLease]
    }
    private var supportsConnectionWake: Bool {
        connected && protocolReady && ledCount == model.totalCount &&
            model.hasQualifiedFirmware(firmware) && S4.supportsPerKey(firmware,model:model)
    }
    private func requireBoardSleepSupport(refreshIdentity: Bool = false) throws {
        try requireConnected()
        if refreshIdentity { try identify() }
        guard supportsBoardSleepLease else {
            throw failure("SLEEP_UNSUPPORTED", "Board sleep control is available only for a verified Air75 V3 1.0.23.6 with a nonempty serial.")
        }
    }
    private func readBoardSleepInfo() throws -> [UInt8] {
        let info = try request(0xf3, length: 4)
        guard info.count == 4, info[0] <= 1 else {
            throw failure("SLEEP_REPLY_INVALID", "The board sleep reply has an invalid enable flag; no unverified sleep setting will be written.")
        }
        return info
    }
    func readBoardSleep() throws -> [String:Any] {
        try requireBoardSleepSupport()
        return ["sleepInfo":try readBoardSleepInfo(),"boardSleepLease":boardSleepLeaseStatus,"verified":true]
    }
    private func requireSleepOriginal(_ saved: BoardSleepBackup) throws {
        guard boardSleepJournal.exists, try boardSleepJournal.read(serial: serial, firmware: firmware) == saved,
              sleepLeaseOriginal == nil || sleepLeaseOriginal == saved else {
            throw failure("SLEEP_BACKUP_CHANGED", "The original board sleep record changed or disappeared; no sleep setting was written.")
        }
    }
    private func writeBoardSleepEnable(_ enabled: UInt8, before: [UInt8], saved: BoardSleepBackup) throws -> [UInt8] {
        try requireBoardSleepSupport()
        try requireSleepOriginal(saved)
        guard before.count == 4, before[0] <= 1, enabled <= 1 else { throw failure("SLEEP_REPLY_INVALID", "Invalid board sleep enable transition.") }
        // Recheck immediately before F5. A changed time/reserved byte belongs
        // to the keyboard/another utility and must never be replayed from disk.
        guard try readBoardSleepInfo() == before else {
            throw failure("SLEEP_SETTING_CHANGED", "Board sleep settings changed before the write. No setting was written.")
        }
        let generation = connectionGeneration
        sleepMutationAttempted = true
        let echoed = try request(0xf5, length: 1, payload: [enabled])
        guard echoed == [enabled] else { throw failure("SLEEP_ACK_MISMATCH", "The board did not echo the requested sleep enable flag.") }
        guard connected, generation == connectionGeneration else { throw failure("SESSION_CHANGED", "The keyboard disconnected during board sleep control; the original record is retained.") }
        let observed = try readBoardSleepInfo()
        var target = before; target[0] = enabled
        guard observed == target else {
            diagnostic("Board sleep verify expected=\(target) observed=\(observed)")
            throw failure("SLEEP_VERIFY_FAILED", "The board sleep flag or unowned timing bytes did not verify; the original record is retained.")
        }
        return observed
    }
    func acquireBoardSleepLease() throws -> [String:Any] {
        try requireBoardSleepSupport(refreshIdentity: sleepLeaseGeneration != connectionGeneration)
        if sleepMutationAttempted && !boardSleepJournal.exists {
            throw failure("SLEEP_BACKUP_MISSING", "This process changed board sleep but its original record is missing. No new baseline was captured.")
        }
        // Validate an existing original before even considering the already-off
        // fast path. Never recapture zero as the baseline after a crash/unplug.
        let pending = boardSleepJournal.exists ? try boardSleepJournal.read(serial: serial, firmware: firmware) : nil
        if let saved = pending { try requireSleepOriginal(saved) }
        let before = try readBoardSleepInfo()
        if pending == nil && before[0] == 0 {
            return ["sleepInfo":before,"boardSleepLease":boardSleepLeaseStatus,"changed":false,"verified":true,"reason":"alreadyDisabled"]
        }
        let saved: BoardSleepBackup
        if let original = pending { saved = original }
        else {
            saved = BoardSleepBackup(createdAt: ISO8601DateFormatter().string(from: Date()), serial: serial, firmware: firmware, original: before)
            try boardSleepJournal.save(saved)
            try requireSleepOriginal(saved)
        }
        if sleepLeaseGeneration == connectionGeneration, before[0] != saved.installedEnable {
            // Another writer changed our flag during this ownership. Do not
            // fight it by repeatedly disabling sleep behind the user's back.
            _ = try releaseBoardSleepLease()
            throw failure("SLEEP_SETTING_CHANGED", "Board sleep enable changed outside NuPhy Lab. The external setting was preserved.")
        }
        sleepLeaseOriginal = saved
        do {
            let observed = before[0] == 0 ? before : try writeBoardSleepEnable(0, before: before, saved: saved)
            sleepMutationAttempted = sleepMutationAttempted || saved.original[0] != observed[0]
            sleepLeaseGeneration = connectionGeneration
            return ["sleepInfo":observed,"boardSleepLease":boardSleepLeaseStatus,"changed":before[0] != 0,"verified":true]
        } catch {
            let original = error
            do { _ = try releaseBoardSleepLease() }
            catch { throw failure("SLEEP_RESTORE_REQUIRED", "Board sleep control failed: \(original). Restoration also failed: \(error). The original record is retained.") }
            throw original
        }
    }
    func releaseBoardSleepLease() throws -> [String:Any] {
        guard boardSleepLeasePending else {
            return ["boardSleepLease":boardSleepLeaseStatus,"changed":false,"restored":false,"verified":true,"reason":"noBoardSleepLease"]
        }
        // Never reconnect solely to restore a board-global setting: an absent
        // handle may have been replaced by another physical keyboard.
        try requireBoardSleepSupport(refreshIdentity: true)
        guard boardSleepJournal.exists else {
            throw failure("SLEEP_BACKUP_MISSING", "The original board sleep record is missing; recovery cannot be confirmed.")
        }
        let saved = try boardSleepJournal.read(serial: serial, firmware: firmware)
        try requireSleepOriginal(saved)
        let before = try readBoardSleepInfo()
        let externalEnable = before[0] != saved.installedEnable && before[0] != saved.original[0]
        let externalTimes = Array(before.dropFirst()) != Array(saved.original.dropFirst())
        var archive: URL?
        if externalEnable || externalTimes { archive = try boardSleepJournal.archive(saved) }
        let changes = !externalEnable && before[0] != saved.original[0]
        let observed = changes ? try writeBoardSleepEnable(saved.original[0], before: before, saved: saved) : before
        // Confirm again before deleting the only active original. Check all
        // four live bytes, retaining externally changed time/reserved values.
        guard try readBoardSleepInfo() == observed else {
            throw failure("SLEEP_SETTING_CHANGED", "Board sleep settings changed during recovery. The original record is retained.")
        }
        try requireSleepOriginal(saved)
        do { try FileManager.default.removeItem(at: boardSleepJournal.url) }
        catch { throw failure("SLEEP_BACKUP_CLEANUP_FAILED", "Board sleep was verified, but its original record could not be retired.") }
        sleepMutationAttempted = false; sleepLeaseGeneration = nil; sleepLeaseOriginal = nil
        return ["sleepInfo":observed,"boardSleepLease":boardSleepLeaseStatus,"changed":changes,"restored":!externalEnable,"verified":true,
                "preservedExternalChange":externalEnable || externalTimes,"historyPath":archive?.path ?? ""]
    }
    private func connectionSnapshot(state: [UInt8]? = nil) -> [String:Any] {
        var result: [String: Any] = ["connected": connected, "armed": armed, "needsRestore": recoveryPending,
                                     "recoveryPending": recoveryPending, "deferredProfiles": deferredProfiles, "backupPath": backupURL.path,
                                     "firmware": firmware, "ledCount": ledCount,"expectedLedCount":model.totalCount,
                                     "identified": connected && identified,"firmwareDetectionAvailable": connected && identified,
                                     "readOnly": !protocolReady,"protocolReady": protocolReady,
                                     "unsafeWritesNeeded": mutationAttempted || ownsFunctionKeyChanges || sleepMutationAttempted,"functionKeyRecoveryPending": hasFunctionKeyBackup || hasLostFunctionKeyRecovery,
                                     "unownedFunctionKeyHistory": hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery,
                                     "historicalRecoveryLost":hasLostFunctionKeyRecovery,
                                     "boardSleepLease":boardSleepLeaseStatus,
                                     "error": compatibilityError?.message ?? (NSNull() as Any),
                                     "errorCode": compatibilityError?.code ?? (NSNull() as Any),
                                     "permissions": permissionSnapshot(), "keyRecovery": keyRecovery]
        if connected && identified {
            result["model"] = model.name; result["modelId"] = model.rawValue
            result["vendorId"] = 0x19f5; result["productId"] = productID
            result["keyLedCount"] = model.keyCount; result["sideLedCount"] = model.sideCount
            result["state"] = state
            result["lightingProfile"] = lightingProfile
            result["firmwareVersion"] = S4.firmwareVersion(firmware)
            result["firmwareHex"] = firmware.map { String(format:"%02x",$0) }.joined(separator:" ")
            result["transport"] = "USB";result["sideIndependent"] = false
            result["capabilities"] = capabilities
        }
        return result
    }
    func status() throws -> [String: Any] {
        var state:[UInt8]?
        if connected && protocolReady {
            do {state = try readState();try selectRecoveryProfile()}
            catch {
                protocolReady = false;armed = false
                compatibilityError=(error as? BridgeError) ?? failure("PROTOCOL_PROBE_FAILED",error.localizedDescription)
            }
        }
        return connectionSnapshot(state:state)
    }
    func readState() throws -> [UInt8] {
        if !protocolReady,let error=compatibilityError {throw error}
        try refreshLightingProfile()
        guard let length = S4.stateLength(firmware, model: model) else {
            throw failure("UNSUPPORTED_FIRMWARE", "暂不支持此固件，请检查 NuPhy Lab 更新。")
        }
        let state = try request(0xd5, length: length)
        guard S4.readableState(state, firmware: firmware, model: model) else {
            protocolReady = false
            diagnostic("Lighting state probe \(model.rawValue) \(S4.firmwareVersion(firmware)): \(state)")
            throw failure("UNSUPPORTED_PROTOCOL", "正在重新连接键盘，请稍候。")
        }
        return state
    }
    private func keyLayer(_ command: UInt8, _ layer: Int) throws -> [Int] {
        var bytes = [UInt8]()
        let layerBytes = model.keymapKeyCount * 2
        while bytes.count < layerBytes {
            bytes += try request(command,length:min(56,layerBytes-bytes.count),address:layer*layerBytes+bytes.count)
        }
        return stride(from:0,to:layerBytes,by:2).map { Int(bytes[$0]) << 8 | Int(bytes[$0+1]) }
    }
    // This operation itself is read-only, including while F4 is leased.
    func readKeymap() throws -> [String: Any] {
        if !protocolReady,let error=compatibilityError {throw error}
        try requireConnected();try identify()
        let geometry = try request(0xa0,length:8)
        guard model.validGeometry(geometry) else { throw failure("KEYMAP_UNSUPPORTED", "此键盘的键位结构尚不支持自动适配。") }
        let active = try keyLayer(0xb2,Int(geometry[0])*4)
        let defaults = try [keyLayer(0xb1,0),keyLayer(0xb1,4)]
        guard try request(0xa0,length:8) == geometry else { throw failure("KEYMAP_CHANGED", "键盘模式已改变，请重新适配。") }
        return ["mode":Int(geometry[0]),"active":active,"defaults":defaults,"locationId":locationId,
                "firmwareVersion":S4.firmwareVersion(firmware),"readOnly":true,
                "geometryVerified":true,"modelId":model.rawValue,"productId":productID,
                "matrixKeyCount":model.matrixKeyCount,"keymapKeyCount":model.keymapKeyCount,
                "protocol":model.protocolName + "-keymap",
                "functionKeyLeaseSupported":model.supportsFunctionKeyAdaptation(firmware) && keyRecovery["blocking"] as? Bool != true,
                "functionKeyLease":hasFunctionKeyBackup && ownsCurrentFunctionKeyLease && keyRecoveryError == nil,
                "unownedFunctionKeyHistory":hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery,
                "keyRecovery":keyRecovery]
    }
    private let factoryFunctionValues = [105,106,32262,32263,32264,32278,172,174,171,168,170,169]
    private var isolatesSharedFunctionInputs:Bool { model != .air75 && model != .kick75 && model != .air65 }
    private func validFunctionAssignments(_ saved:FunctionKeyBackup,_ defaults:[[Int]]) -> Bool {
        guard defaults.count == 2, defaults.allSatisfy({$0.count == model.keymapKeyCount}) else {return false}
        return saved.assignments.allSatisfy { item in
            defaults[1].firstIndex(of:item.target) == item.position && defaults[1].lastIndex(of:item.target) == item.position &&
            defaults[0][item.position] == saved.original[item.position] && saved.original[item.position] == factoryFunctionValues[item.target-58]
        }
    }
    private func plannedFunctionAssignments(_ active:[Int],_ defaults:[[Int]],_ keys:[String]) throws -> [FunctionKeyAssignment] {
        var result=[FunctionKeyAssignment]()
        for target in 58...69 where keys.contains("F\(target-57)") {
            guard let position=defaults[1].firstIndex(of:target),defaults[1].lastIndex(of:target)==position,position<model.matrixKeyCount else {
                throw failure("KEYMAP_UNSUPPORTED","无法确认功能键的物理位置。")
            }
            let original=factoryFunctionValues[target-58]
            guard active[position]==original,defaults[0][position]==original else {continue}
            let shared = isolatesSharedFunctionInputs && active.filter{$0==original}.count>1
            if target==61 || shared {result.append(FunctionKeyAssignment(position:position,target:target))}
        }
        return result
    }
    private func loadFunctionKeyBackup() throws -> FunctionKeyBackup {
        let record:FunctionKeyBackup
        do { record = try JSONDecoder().decode(FunctionKeyBackup.self,from:Data(contentsOf:functionKeyBackupURL)) }
        catch { throw failure("KEY_LEASE_BACKUP", "功能键原键位备份无法读取，已保留文件并停止修改。") }
        guard (record.modelId ?? USBKeyboardModel.air75.rawValue) == model.rawValue,
              (record.productID ?? 0x1028) == productID,
              (record.keymapKeyCount ?? 98) == model.keymapKeyCount,
              record.firmware.count == 6,record.locationId > 0,
              record.original.count == model.keymapKeyCount,record.original.allSatisfy({(0...65535).contains($0)}),
              !record.assignments.isEmpty,record.assignments.count<=12,
              record.position==record.assignments[0].position,
              Set(record.assignments.map{$0.position}).count==record.assignments.count,
              Set(record.assignments.map{$0.target}).count==record.assignments.count,
              record.leased == nil || isolatesSharedFunctionInputs,
              record.assignments.allSatisfy({item in (0..<model.matrixKeyCount).contains(item.position) &&
                  (58...69).contains(item.target) && record.original[item.position]==factoryFunctionValues[item.target-58]}) else {
            throw failure("KEY_LEASE_BACKUP", "功能键原键位备份格式无效，已停止修改。")
        }
        return record
    }
    private func verifyFunctionKeyTransaction(_ saved:FunctionKeyBackup,_ journal:Data,_ generation:UInt64,_ location:Int) throws {
        try requireConnected();try readIdentity()
        guard protocolReady,model.supportsFunctionKeyAdaptation(firmware),generation==connectionGeneration,location==locationId,
              ownsCurrentFunctionKeyLease,saved.serial==serial,
              saved.firmware==Array(firmware.prefix(6)),try loadFunctionKeyBackup()==saved,
              try Data(contentsOf:functionKeyBackupURL)==journal else {
            throw failure("KEY_LEASE_CHANGED","连接或原键位记录已改变，已停止修改并保留备份。")
        }
    }
    private func writeFunctionKey(_ position:Int,_ value:Int,expected:Int,saved:FunctionKeyBackup,journal:Data,generation:UInt64,location:Int) throws {
        guard (0..<model.matrixKeyCount).contains(position),((58...69).contains(value) || factoryFunctionValues.contains(value)) else { throw failure("KEY_LEASE_INVALID", "Invalid F4 lease.") }
        // A multi-key transaction can yield to other control clients between
        // writes. Check the actual next slot, never reuse the first snapshot.
        let current=try request(0xb2,length:2,address:position*2)
        guard current == [UInt8(expected>>8),UInt8(expected&255)] else {
            throw failure("KEY_LEASE_CHANGED","功能键已被重新配置，已停止修改并保留新配置。")
        }
        try verifyFunctionKeyTransaction(saved,journal,generation,location)
        let bytes=[UInt8(value >> 8),UInt8(value & 255)]
        _ = try request(0xb3,length:2,address:position*2,payload:bytes)
        // The ACK can precede the keymap commit. Read again, never blind-retry a write.
        for attempt in 0..<5 {
            if attempt > 0 {pump(0.04)}
            let read = try request(0xb2,length:2,address:position*2)
            if read == bytes {return}
        }
        throw failure("KEY_LEASE_VERIFY", "F4 配置未通过回读检查，原键位备份已保留。")
    }
    // The parent JSON request waits 12 seconds. One native key operation has
    // eight seconds total, including reads and rollback; nested calls cannot
    // renew it. Expiry retains recovery data and prevents any later USB frame.
    private func withFunctionKeyBudget<T>(_ operation:()throws->T) throws -> T {
        let previous=functionKeyDeadline
        if previous == nil {functionKeyDeadline=transactionUptime+8}
        defer {functionKeyDeadline=previous}
        return try operation()
    }
    func prepareFunctionKey(_ keys:[String] = ["F4"]) throws -> [String:Any] {
        guard !keys.isEmpty,keys.allSatisfy({ key in (1...12).contains(where:{key=="F\($0)"}) }) else {throw failure("KEY_LEASE_INVALID","Invalid function keys")}
        do {return try withFunctionKeyBudget {try performFunctionKeyPreparation(keys)}}
        catch {
            if hasFunctionKeyBackup || functionKeyMutationAttempted {keyRecoveryError=(error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription)}
            throw error
        }
    }
    private func performFunctionKeyPreparation(_ keys:[String]) throws -> [String:Any] {
        let map = try readKeymap()
        guard let mode=map["mode"] as? Int,let active=map["active"] as? [Int],let defaults=map["defaults"] as? [[Int]] else {
            throw failure("KEYMAP_UNSUPPORTED", "无法确认功能键的物理位置。")
        }
        if hasFunctionKeyBackup {
            guard ownsCurrentFunctionKeyLease else {
                let error=failure("KEY_LEASE_CONFIRMATION_REQUIRED","检测到上次功能键适配记录，请先确认当前仍是原键盘并恢复。")
                keyRecoveryError=error;throw error
            }
            let saved = try loadFunctionKeyBackup()
            var expected=saved.original
            for item in saved.assignments {expected[item.position]=item.target}
            guard mode==0,saved.serial==serial,saved.locationId==locationId,
                  saved.firmware==Array(firmware.prefix(6)),validFunctionAssignments(saved,defaults),active==expected else {
                throw failure("KEY_LEASE_CHANGED", "键盘配置已改变，请关闭模式并恢复原键位后重试。")
            }
            let next=try plannedFunctionAssignments(saved.original,defaults,keys)
            if next != saved.assignments {
                _ = try restoreFunctionKey()
                return try performFunctionKeyPreparation(keys)
            }
            functionKeyMutationAttempted=true;functionKeyOwnerConnection=connectionGeneration;keyRecoveryError=nil
            return ["leased":true,"verified":true,"keys":saved.assignments.map{"F\($0.target-57)"}]
        }
        guard mode==0 else {return ["leased":false,"verified":true,"keys":[]]}
        let assignments=try plannedFunctionAssignments(active,defaults,keys)
        guard let first=assignments.first else {return ["leased":false,"verified":true,"keys":[]]}
        guard protocolReady,model.supportsFunctionKeyAdaptation(firmware),locationId>0 else { throw failure("KEYMAP_UNSUPPORTED", "键盘未通过功能键兼容检查。") }
        let record=FunctionKeyBackup(firmware:Array(firmware.prefix(6)),serial:serial,locationId:locationId,position:first.position,original:active,
                                     modelId:model.rawValue,productID:productID,keymapKeyCount:model.keymapKeyCount,leased:isolatesSharedFunctionInputs ? assignments : nil)
        try FileManager.default.createDirectory(at:functionKeyBackupURL.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try JSONEncoder().encode(record).write(to:functionKeyBackupURL,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:functionKeyBackupURL.path)
        let journalHandle = try FileHandle(forWritingTo:functionKeyBackupURL)
        do { try journalHandle.synchronize(); try journalHandle.close() } catch { try? journalHandle.close(); throw error }
        guard try loadFunctionKeyBackup() == record else { throw failure("KEY_LEASE_BACKUP","功能键原键位备份未通过落盘校验，未修改键位。") }
        functionKeyMutationAttempted=true; functionKeyOwnerConnection=connectionGeneration; keyRecoveryError=nil
        let journal=try Data(contentsOf:functionKeyBackupURL),generation=connectionGeneration,location=locationId
        do {
            var expected=active
            for item in assignments {
                guard try keyLayer(0xb2,0)==expected else {throw failure("KEY_LEASE_CHANGED","键盘配置已改变，已停止接管并保留新配置。")}
                try writeFunctionKey(item.position,item.target,expected:expected[item.position],saved:record,journal:journal,generation:generation,location:location)
                expected[item.position]=item.target
            }
            try verifyFunctionKeyTransaction(record,journal,generation,location)
            guard try keyLayer(0xb2,0)==expected else {throw failure("KEY_LEASE_VERIFY","功能键适配未通过完整键位回读。")}
        } catch { _ = try? restoreFunctionKey();throw error }
        return ["leased":true,"verified":true,"keys":assignments.map{"F\($0.target-57)"}]
    }
    func restoreFunctionKey() throws -> [String:Any] {
        do {return try withFunctionKeyBudget {try performAutomaticFunctionKeyRestore()}}
        catch {
            keyRecoveryError=(error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription)
            throw error
        }
    }
    private func performAutomaticFunctionKeyRestore() throws -> [String:Any] {
        guard hasFunctionKeyBackup else {
            guard !functionKeyMutationAttempted else {
                throw failure("KEY_LEASE_BACKUP","本轮 功能键临时键位的原备份缺失，无法确认恢复；已停止后续修改。")
            }
            return ["restored":true]
        }
        guard connected else {return ["restored":false,"deferred":true]}
        guard ownsCurrentFunctionKeyLease else {
            let error=failure("KEY_LEASE_CONFIRMATION_REQUIRED","检测到上次功能键适配记录或 USB 接口已改变，请确认同一把键盘后恢复。")
            keyRecoveryError=error;throw error
        }
        guard protocolReady else {throw compatibilityError ?? failure("UNSUPPORTED_PROTOCOL","键盘兼容性尚未确认，功能键原键位备份已保留，未修改键位。")}
        let saved=try loadFunctionKeyBackup(),map=try readKeymap()
        guard let defaults=map["defaults"] as? [[Int]],validFunctionAssignments(saved,defaults),
              saved.serial==serial,saved.locationId==locationId else {
            throw failure("KEY_LEASE_DEVICE", "请将原键盘接回原 USB 接口以恢复功能键。备份已保留。")
        }
        let current = try keyLayer(0xb2,0),positions=Set(saved.assignments.map{$0.position})
        guard saved.firmware==Array(firmware.prefix(6)),current.indices.allSatisfy({positions.contains($0) || current[$0]==saved.original[$0]}) else {
            throw failure("KEY_LEASE_CHANGED", "键盘配置已改变，原键位备份已保留，未覆盖新配置。")
        }
        let journal=try Data(contentsOf:functionKeyBackupURL),generation=connectionGeneration,location=locationId
        var expected=current,external=false
        for item in saved.assignments {
            let latest=try keyLayer(0xb2,0)
            try verifyFunctionKeyTransaction(saved,journal,generation,location)
            guard latest.count==saved.original.count,latest.indices.allSatisfy({positions.contains($0) || latest[$0]==saved.original[$0]}) else {
                throw failure("KEY_LEASE_CHANGED","键盘配置已改变，原键位备份已保留，未覆盖新配置。")
            }
            expected=latest
            external = external || saved.assignments.contains {latest[$0.position] != $0.target && latest[$0.position] != saved.original[$0.position]}
            if latest[item.position]==item.target {
                try writeFunctionKey(item.position,saved.original[item.position],expected:item.target,saved:saved,journal:journal,generation:generation,location:location)
                expected[item.position]=saved.original[item.position]
            }
        }
        try verifyFunctionKeyTransaction(saved,journal,generation,location)
        guard try keyLayer(0xb2,0)==expected else {throw failure("KEY_LEASE_VERIFY","功能键恢复未通过完整键位回读。")}
        if external {
            // Preserve explicit edits while restoring all other owned positions.
            let dir=functionKeyBackupURL.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
            try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
            try FileManager.default.moveItem(at:functionKeyBackupURL,to:dir.appendingPathComponent("function-key-\(UUID().uuidString).json"))
        } else {try FileManager.default.removeItem(at:functionKeyBackupURL)}
        functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil;keyRecoveryError=nil;functionKeyRecoveryPreview=nil
        return ["restored":true,"verified":true,"externalChangePreserved":external]
    }
    private var currentFunctionKeyRecoveryIdentity:[String:Any] {
        ["model":model.name,"firmware":S4.firmwareVersion(firmware),"port":locationId]
    }
    private func archiveObservedOriginalFunctionKeyHistory() throws -> Bool {
        guard connected,protocolReady,hasFunctionKeyBackup,!ownsCurrentFunctionKeyLease,!hasLostFunctionKeyRecovery else {return false}
        let data=try Data(contentsOf:functionKeyBackupURL),saved=try loadFunctionKeyBackup()
        let map=try readKeymap(),mac=try keyLayer(0xb2,0)
        let defaults=map["defaults"] as? [[Int]] ?? []
        guard protocolReady,model.supportsFunctionKeyAdaptation(firmware),saved.serial==serial,
              saved.firmware==Array(firmware.prefix(6)),defaults.count==2,
              defaults[0].count==model.keymapKeyCount,defaults[1].count==model.keymapKeyCount,
              validFunctionAssignments(saved,defaults),mac==saved.original,
              try Data(contentsOf:functionKeyBackupURL)==data else {return false}
        let directory=functionKeyBackupURL.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let archive=directory.appendingPathComponent("function-key-observed-original-\(UUID().uuidString).json")
        // A generic USB identifier cannot establish the original physical
        // keyboard. This audit records only a complete, already-original map
        // observed on the current connection, with zero USB writes.
        let audit:[String:Any]=["action":"archiveObservedOriginal","automaticReadOnlyVerification":true,
                               "physicalIdentityConfirmed":false,"sameKeyboardConfirmed":false,
                               "originalPort":saved.locationId,"currentPort":locationId,"model":model.rawValue,
                               "firmware":S4.firmwareVersion(firmware),"writtenPositions":[],
                               "verifiedKeymapEntries":mac.count,"archive":archive.lastPathComponent,
                               "observedAt":ISO8601DateFormatter().string(from:Date())]
        let auditURL=archive.appendingPathExtension("audit.json")
        try JSONSerialization.data(withJSONObject:audit,options:[.prettyPrinted,.sortedKeys]).write(to:auditURL,options:.withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:auditURL.path)
        let auditHandle=try FileHandle(forWritingTo:auditURL)
        do {try auditHandle.synchronize();try auditHandle.close()} catch {try? auditHandle.close();throw error}
        guard !ownsCurrentFunctionKeyLease,try Data(contentsOf:functionKeyBackupURL)==data else {
            throw failure("KEY_RECOVERY_STALE","连接或恢复记录已改变，请重新检查后确认。")
        }
        try FileManager.default.moveItem(at:functionKeyBackupURL,to:archive)
        guard try Data(contentsOf:archive)==data else {
            try? FileManager.default.moveItem(at:archive,to:functionKeyBackupURL)
            throw failure("KEY_RECOVERY_ARCHIVE","原恢复记录归档校验失败，请保留诊断记录。")
        }
        let handle=try FileHandle(forWritingTo:archive)
        do {try handle.synchronize();try handle.close()} catch {try? handle.close();throw error}
        functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil;keyRecoveryError=nil;functionKeyRecoveryPreview=nil
        return true
    }
    func previewFunctionKeyRecovery() throws -> [String:Any] {
        functionKeyRecoveryPreview=nil
        guard hasFunctionKeyBackup else {
            return ["token":NSNull(),"original":["model":"unknown","firmware":"unknown","port":0],"current":currentFunctionKeyRecoveryIdentity,"checks":[],"canConfirm":false,"action":"restore","alreadyRestored":false,"recovery":keyRecovery]
        }
        try requireConnected()
        guard protocolReady else {throw compatibilityError ?? failure("KEY_RECOVERY_PROTOCOL","请先恢复稳定连接，再检查 F4 恢复记录。")}
        let data=try Data(contentsOf:functionKeyBackupURL)
        let saved:FunctionKeyBackup
        do {saved=try loadFunctionKeyBackup()}
        catch {
            keyRecoveryError=(error as? BridgeError) ?? failure("KEY_LEASE_BACKUP",error.localizedDescription)
            let raw=try? JSONDecoder().decode(FunctionKeyBackup.self,from:data)
            let original:[String:Any]=["model":raw.flatMap{USBKeyboardModel(rawValue:$0.modelId ?? USBKeyboardModel.air75.rawValue)}?.name ?? "unknown",
                                       "firmware":raw.map{S4.firmwareVersion($0.firmware+[0,0])} ?? "unknown","port":raw?.locationId ?? 0]
            return ["token":NSNull(),"original":original,"current":currentFunctionKeyRecoveryIdentity,"checks":[["id":"backup","label":"原恢复记录格式和型号有效","passed":false]],"canConfirm":false,"action":"restore","alreadyRestored":false,"recovery":keyRecovery]
        }
        let map=try readKeymap(),mac=try keyLayer(0xb2,0)
        let defaults=map["defaults"] as? [[Int]] ?? []
        let positionOK=validFunctionAssignments(saved,defaults)
        let firmwareOK=saved.firmware==Array(firmware.prefix(6))
        let serialOK=saved.serial==serial
        let positions=Set(saved.assignments.map{$0.position})
        let otherKeysOK=mac.count==saved.original.count && mac.indices.allSatisfy{positions.contains($0) || mac[$0]==saved.original[$0]}
        let valueOK=saved.assignments.allSatisfy{mac.indices.contains($0.position) && [$0.target,saved.original[$0.position]].contains(mac[$0.position])}
        let recordOK=(try Data(contentsOf:functionKeyBackupURL))==data
        let protocolOK=protocolReady && model.supportsFunctionKeyAdaptation(firmware)
        let checks:[[String:Any]]=[
            ["id":"identity","label":"键盘型号、产品及键位结构与原记录一致","passed":true],
            ["id":"firmware","label":"当前固件与原记录一致","passed":firmwareOK],
            ["id":"serial","label":"USB 标识与原记录一致（仍需确认同一把实体键盘）","passed":serialOK],
            ["id":"position","label":"临时功能键的位置和原功能已验证","passed":positionOK],
            ["id":"otherKeys","label":"临时功能键以外的全部原键位保持一致","passed":otherKeysOK],
            ["id":"f4Value","label":"当前为已知临时键或原始功能","passed":valueOK],
            ["id":"record","label":"原恢复记录未被更改","passed":recordOK],
            ["id":"protocol","label":"当前协议允许安全恢复功能键","passed":protocolOK],
            ["id":"port","label":"USB 接口与记录相同（换接口时需确认同一把键盘）","passed":saved.locationId==locationId,"required":false]
        ]
        let canConfirm=firmwareOK && serialOK && positionOK && otherKeysOK && valueOK && recordOK && protocolOK
        let alreadyRestored=valueOK && mac==saved.original
        let action=alreadyRestored ? "archiveVerifiedOriginal" : "restore"
        let token=UUID().uuidString
        if canConfirm {
            functionKeyRecoveryPreview=FunctionKeyRecoveryPreview(token:token,journal:data,saved:saved,mac:mac,firmware:Array(firmware.prefix(6)),serial:serial,location:locationId,generation:connectionGeneration,action:action)
            keyRecoveryError=failure("KEY_LEASE_CONFIRMATION_REQUIRED","请确认当前仍是原键盘；恢复操作只会还原临时功能键，其他键位保持不变。")
        } else {keyRecoveryError=failure("KEY_RECOVERY_MISMATCH","当前键盘或配置与原恢复记录不一致，已保留备份，未修改任何键位。")}
        return ["token":canConfirm ? token : NSNull() as Any,
                "original":["model":model.name,"firmware":S4.firmwareVersion(saved.firmware+[0,0]),"port":saved.locationId],
                "current":["model":model.name,"firmware":S4.firmwareVersion(firmware),"port":locationId],
                "checks":checks,"canConfirm":canConfirm,"action":action,"alreadyRestored":alreadyRestored,"recovery":keyRecovery]
    }
    func confirmFunctionKeyRecovery(_ command:[String:Any]) throws -> [String:Any] {
        do {return try withFunctionKeyBudget {try performConfirmedFunctionKeyRecovery(command)}}
        catch {
            if hasFunctionKeyBackup || functionKeyMutationAttempted {keyRecoveryError=(error as? BridgeError) ?? failure("KEY_RECOVERY_REQUIRED",error.localizedDescription)}
            throw error
        }
    }
    private func performConfirmedFunctionKeyRecovery(_ command:[String:Any]) throws -> [String:Any] {
        guard command["sameKeyboard"] as? Bool == true,let token=command["token"] as? String,
              let preview=functionKeyRecoveryPreview,preview.token==token else {
            throw failure("KEY_RECOVERY_CONFIRMATION","请先重新检查，并明确确认当前是原来那把键盘。")
        }
        // A confirmation is consumed before any further reads or mutations.
        functionKeyRecoveryPreview=nil
        try requireConnected()
        guard protocolReady,preview.generation==connectionGeneration,preview.location==locationId,preview.serial==serial,
              try Data(contentsOf:functionKeyBackupURL)==preview.journal else {
            throw failure("KEY_RECOVERY_STALE","连接或恢复记录已改变，请重新检查后确认。")
        }
        let map=try readKeymap(),mac=try keyLayer(0xb2,0)
        let defaults=map["defaults"] as? [[Int]] ?? []
        let saved=try loadFunctionKeyBackup()
        guard saved==preview.saved,Array(firmware.prefix(6))==preview.firmware,saved.firmware==preview.firmware,
              mac==preview.mac,validFunctionAssignments(saved,defaults),
              protocolReady,model.supportsFunctionKeyAdaptation(firmware),
              try Data(contentsOf:functionKeyBackupURL)==preview.journal else {
            throw failure("KEY_RECOVERY_STALE","键盘配置已改变，请重新检查后确认。原备份已保留。")
        }
        let shouldWrite=preview.action=="restore"
        var writtenPositions=[Int]()
        if shouldWrite {
            functionKeyMutationAttempted=true;functionKeyOwnerConnection=connectionGeneration
            var expected=mac
            for item in saved.assignments where mac[item.position] == item.target {
                guard try keyLayer(0xb2,0)==expected else {throw failure("KEY_RECOVERY_STALE","键盘配置已改变，请重新检查后确认。原备份已保留。")}
                try writeFunctionKey(item.position,saved.original[item.position],expected:item.target,saved:saved,journal:preview.journal,generation:preview.generation,location:preview.location)
                expected[item.position]=saved.original[item.position];writtenPositions.append(item.position)
            }
        }
        let restored=try keyLayer(0xb2,0)
        guard restored==saved.original,try Data(contentsOf:functionKeyBackupURL)==preview.journal else {
            keyRecoveryError=failure("KEY_RECOVERY_VERIFY","F4 恢复未通过完整回读，原备份已保留。")
            throw keyRecoveryError!
        }
        functionKeyMutationAttempted=false;functionKeyOwnerConnection=nil
        let directory=functionKeyBackupURL.deletingLastPathComponent().appendingPathComponent("key-recovery-history")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let archive=directory.appendingPathComponent("function-key-confirmed-\(UUID().uuidString).json")
        let audit:[String:Any]=["action":preview.action,"sameKeyboardConfirmed":true,"originalPort":saved.locationId,
                               "currentPort":locationId,"model":model.rawValue,"firmware":S4.firmwareVersion(firmware),
                               "writtenPositions":writtenPositions,"verifiedKeymapEntries":restored.count,
                               "archive":archive.lastPathComponent,"confirmedAt":ISO8601DateFormatter().string(from:Date())]
        let auditData=try JSONSerialization.data(withJSONObject:audit,options:[.prettyPrinted,.sortedKeys])
        let auditURL=archive.appendingPathExtension("audit.json")
        try auditData.write(to:auditURL,options:.withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:auditURL.path)
        let auditHandle=try FileHandle(forWritingTo:auditURL)
        do {try auditHandle.synchronize();try auditHandle.close()} catch {try? auditHandle.close();throw error}
        // Move the exact original bytes into history only after full readback.
        // Never rewrite its USB location to impersonate a new physical identity.
        try FileManager.default.moveItem(at:functionKeyBackupURL,to:archive)
        guard try Data(contentsOf:archive)==preview.journal else {
            try? FileManager.default.moveItem(at:archive,to:functionKeyBackupURL)
            throw failure("KEY_RECOVERY_ARCHIVE","原恢复记录归档校验失败，请保留诊断记录。")
        }
        let archiveHandle=try FileHandle(forWritingTo:archive)
        do {try archiveHandle.synchronize();try archiveHandle.close()} catch {try? archiveHandle.close();throw error}
        keyRecoveryError=nil
        return ["restored":true,"verified":true,"archived":true,"writesPerformed":shouldWrite,"keymapEntriesVerified":restored.count,"recovery":keyRecovery]
    }
    func readRGB() throws -> [UInt8] {
        if !protocolReady,let error=compatibilityError {throw error}
        _ = try requireConnected()
        // D8 acknowledgement precedes the firmware's rendered D2 buffer update.
        // Reading immediately can mix 18 old LEDs with the rest of the new frame.
        // Wait only on diagnostic reads; ordinary animation writes stay unblocked.
        if let writtenAt = lastRGBWriteAt {
            let remaining = writtenAt + 0.045 - ProcessInfo.processInfo.systemUptime
            if remaining > 0 { pump(remaining) }
        }
        var bytes = [UInt8]()
        while bytes.count < model.totalCount * 3 {
            let count = min(54, model.totalCount * 3 - bytes.count)
            bytes += try request(0xd2, length: count, address: bytes.count)
            if bytes.count < model.totalCount * 3 { pump(0.008) }
        }
        return bytes
    }
    private func loadBackup() throws -> LightingBackup {
        let record = try journals.read(backupURL, serial: serial)
        guard (record.lightingProfile ?? 0) == lightingProfile else {
            throw failure("INVALID_BACKUP", "The lighting backup does not belong to this profile.")
        }
        return record
    }
    private func ensureBackup(requirePerKey: Bool = true) throws {
        _ = try requireConnected()
        if requirePerKey, model.globalPalette, !deferredProfiles.isEmpty {
            // Kick's D8 palette is global, while D5/D6 state is per profile.
            // Do not create a second profile's baseline from a leased palette.
            throw failure("RECOVERY_REQUIRED", "请先切回原 Mac/Win 档位恢复灯效，再控制另一档位。")
        }
        if mutationAttempted, backup != nil { return }
        guard !recoveryPending else {
            throw failure("RECOVERY_REQUIRED", "A previous lighting backup exists. Call restore before starting another lighting session.")
        }
        guard protocolReady, !requirePerKey || S4.supportsPerKey(firmware, model: model) else { throw failure("PER_KEY_UNSUPPORTED", "此固件尚不支持逐键灯效；Kick75 请通过 NuPhyIO 更新到 4.0.18.6，原生灯效仍可使用。") }
        let state = try readState()
        let capturedProfile = lightingProfile
        guard state[9] <= 4 else { throw failure("UNSUPPORTED_SIDE_MODE", "The current side mode is outside the five stock modes; no configuration was changed.") }
        if model == .air75 && state.count == 17 && state[0] == 21 && state[1] != 100 {
            throw failure("CUSTOM_BACKUP_LOSSY", "Another custom renderer is active below 100% brightness. Its original RAM values cannot be recovered exactly; select a stock effect first.")
        }
        let colors = try readRGB()
        try refreshLightingProfile()
        guard capturedProfile == lightingProfile else {
            throw failure("LIGHTING_PROFILE_CHANGED", "键盘档位已改变，请重新播放灯效。")
        }
        let record = LightingBackup(createdAt: ISO8601DateFormatter().string(from: Date()), productID: productID, serial: serial,
                                    firmware: firmware, state: state, renderedColors: colors, lightingProfile: lightingProfile)
        do {
            try FileManager.default.createDirectory(at: backupURL.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            // Exclusive creation prevents two bridges from replacing the original.
            let fd = Darwin.open(backupURL.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard fd >= 0 else { throw failure("BACKUP_CREATE_FAILED", "Cannot exclusively create backup; another lighting session may be active.") }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            do {
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try handle.write(contentsOf: encoder.encode(record))
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                // A failed backup is retained for review; no device write follows.
                throw error
            }
            backup = record
        } catch let error as BridgeError { throw error }
        catch { throw failure("BACKUP_SAVE_FAILED", "No lighting was changed because the backup could not be saved: \(error.localizedDescription)") }
    }
    private func writeStateVerified(_ state: [UInt8]) throws {
        try verifyLightingProfileForWrite()
        let expectedProfile = lightingProfile
        let current = try readState()
        try requireOwnedLightingProfile(expectedProfile)
        let plan = try S4.stateWritePlan(state, current: current, firmware: firmware, model: model)
        for segment in plan {
            try requireOwnedLightingProfile(expectedProfile)
            var payload = segment.payload
            if model == .air75 && segment.address == 0 && Array(firmware.prefix(6)) == [23,0,1,170,6,0] {
                payload.replaceSubrange(6..<9, with: try S4.exactMainColorInput(Array(state[6..<9])))
            }
            // Never transmit preset fields; keep main/side RGB triplets intact.
            let echo = try request(0xd6, length: payload.count, address: segment.address, payload: payload)
            guard echo == payload else { throw failure("STATE_ACK_MISMATCH", "D6 did not echo the complete lighting payload.") }
            pump(0.12)
        }
        var lastRead = [UInt8]()
        for attempt in 0..<5 {
            lastRead = try readState()
            try requireOwnedLightingProfile(expectedProfile)
            if S4.ownedStateMatches(state, lastRead, firmware: firmware, model: model) { return }
            if attempt < 4 { pump(0.12) }
        }
        diagnostic("D6 verify expected=\(state) actual=\(lastRead)")
        throw failure(S4.stateMismatchCode(expected: state, observed: lastRead), "D5 mismatch: expected \(state), observed \(lastRead).")
    }
    private func requireOwnedLightingProfile(_ expected: UInt8) throws {
        // readState() performs another A0 and may discover a physical switch
        // after the first write check. Never address that newly selected profile
        // with a different profile's original journal, or accept its readback.
        guard lightingProfile == expected, let saved = backup,
              (saved.lightingProfile ?? 0) == expected else {
            throw failure("LIGHTING_PROFILE_CHANGED", "Keyboard profile changed before a verified lighting write; original journal retained.")
        }
    }
    private func withSleepArmFailureCleanup(_ action: () throws -> [String:Any]) throws -> [String:Any] {
        do { return try action() }
        catch {
            let original = error
            // A durable sleep lease can precede even RGB preflight. Keep this
            // outside the existing RGB rollback scope so malformed lighting
            // originals, profile changes and identity failures also hand it back.
            if boardSleepLeasePending {
                do { _ = try releaseBoardSleepLease() }
                catch { throw failure("SLEEP_RESTORE_REQUIRED", "Lighting preparation failed: \(original). Board sleep restoration also failed: \(error). Its original record is retained.") }
            }
            throw original
        }
    }
    func arm() throws -> [String: Any] {
        try withSleepArmFailureCleanup { try armWithLightingBackup() }
    }
    private func armWithLightingBackup() throws -> [String: Any] {
        guard S4.supportsPerKey(firmware, model: model) else { throw failure("PER_KEY_UNSUPPORTED", "此固件尚不支持逐键灯效；Kick75 请通过 NuPhyIO 更新到 4.0.18.6，原生灯效仍可使用。") }
        if armed { return ["armed": true, "backupPath": backupURL.path, "alreadyArmed": true] }
        try ensureBackup()
        var next = try readState()
        next[0] = 21; next[1] = 100; next[4] = 1
        // New firmware renders the stored palette through the main colour's
        // value as well as brightness. Use white while owning per-key output.
        if next.count == 22 { next.replaceSubrange(6..<9, with: [255,255,255]) }
        mutationAttempted = true
        do {
            try writeStateVerified(next)
            if next.count == 22 || model.globalPalette, let saved = backup, saved.customColors == nil {
                // Capture the board's loaded custom palette before the first
                // D8 can change it. The state-only journal already protects
                // crashes during this temporary switch to custom mode.
                let custom = try S4.paletteFromRendered(Array(try readRGB().prefix(model.keyCount * 3)), firmware: firmware, model: model)
                backup = try journals.saveCustomColors(custom, record: saved, serial: serial)
            }
            armed = true; firstPaintVerified = false; lastPaint = nil
            return ["armed": true, "state": next, "backupPath": backupURL.path, "verified": true]
        } catch { throw rollbackError(error) }
    }
    func armConnectionWake() throws -> [String: Any] {
        try withSleepArmFailureCleanup { try prepareConnectionWake() }
    }
    private func prepareConnectionWake() throws -> [String: Any] {
        try requireConnected()
        guard supportsConnectionWake else {
            throw failure("CONNECTION_WAKE_UNSUPPORTED", "This keyboard has no verified connection-wake preparation path.")
        }
        try identify()
        guard supportsConnectionWake, !hasLostFunctionKeyRecovery else {
            throw failure("CONNECTION_WAKE_UNSUPPORTED", "Keyboard identity or recovery changed before connection-wake preparation.")
        }
        var current = try readState()
        if let live = backup, (live.lightingProfile ?? 0) != lightingProfile {
            throw failure("LIGHTING_PROFILE_CHANGED", "Keyboard profile changed; the original recovery record is retained.")
        }
        try journals.migrateLegacy(serial: serial)
        var retainedOriginal = recoveryPending
        if retainedOriginal {
            let durable = try loadBackup()
            guard backup == nil || backup == durable,
                  Array(durable.firmware.prefix(6)) == Array(firmware.prefix(6)) else {
                throw failure("INVALID_BACKUP", "The original connection-wake recovery record changed or belongs to another firmware.")
            }
            backup = durable
            // Empty serials use the existing verified restoration path. They do
            // not establish the physical identity needed for quiet continuation.
            if serial.isEmpty || durable.serial.isEmpty {
                _ = try restore()
                current = try readState()
                retainedOriginal = false
            } else if durable.serial != serial {
                throw failure("BACKUP_DEVICE_MISMATCH", "The pending connection-wake record belongs to another keyboard.")
            }
        }
        if !retainedOriginal { try ensureBackup() }
        guard let original = backup, try loadBackup() == original else {
            throw failure("INVALID_BACKUP", "The original connection-wake backup is not durably verified.")
        }
        let quietPreparation = retainedOriginal && original.customColors != nil
        var presetArchive: URL?
        if S4.presetFieldsDiffer(original.state, current, firmware: firmware, model: model) {
            presetArchive = try journals.preservePresetHistory(original, serial: serial)
        }
        var ready = current
        ready[0] = 21; ready[1] = 100; ready[4] = 1
        ready.replaceSubrange(6..<9, with: [255,255,255])
        ready[9] = 2; ready[10] = 0; ready[12] = 0; ready[13] = 0
        ready.replaceSubrange(14..<17, with: [0,0,0])
        let black = [UInt8](repeating: 0, count: model.keyCount * 3)
        armed = false; firstPaintVerified = false; lastPaint = nil
        mutationAttempted = true
        do {
            if quietPreparation {
                // Verified 1.0.23.6 has no independent brightness gate: D6
                // brightness writes HSV V, and a later RGB-white field resets
                // V to 200. D2 and the LED driver share that rendered buffer.
                // Only an already durable complete palette lets us enter dark,
                // overwrite the live table, then enable white without exposing
                // the old table. Re-selecting 21 does not reload a same-profile
                // D8 table (official binary cd5c/cdb0/148fc; see QA evidence).
                var dark = ready
                dark[1] = 0; dark.replaceSubrange(6..<9, with: [0,0,0])
                try writeStateVerified(dark)
            } else {
                // A fresh/state-only original must capture its persistent
                // palette before D8. This necessarily exposes that main table;
                // mute side lights in the same D6 and minimize the native gap.
                try writeStateVerified(ready)
                if original.customColors == nil {
                    let custom = try S4.paletteFromRendered(Array(try readRGB().prefix(model.keyCount * 3)), firmware: firmware, model: model)
                    backup = try journals.saveCustomColors(custom, record: original, serial: serial)
                }
            }
            try writeRGB(black)
            if quietPreparation { try writeStateVerified(ready) }
            let verificationStarted = ProcessInfo.processInfo.systemUptime
            var rendered = try readRGB()
            var observed = try readState()
            try requireOwnedLightingProfile(original.lightingProfile ?? 0)
            func nonblackKeys(_ pixels: [UInt8]) -> [Int] {
                (0..<model.keyCount).filter { index in
                    pixels[(index * 3)..<(index * 3 + 3)].contains(where: { $0 != 0 })
                }
            }
            func reportBlackout(_ stage: String, _ pixels: [UInt8], _ state: [UInt8]) -> Bool {
                let colors = hexColors(pixels)
                let nonblack = colors.indices.filter { colors[$0] != "#000000" }
                let main = nonblack.filter { $0 < model.keyCount }
                let side = nonblack.filter { $0 >= model.keyCount }
                let evidence = nonblack.map { "\($0):\(colors[$0])" }.joined(separator: ",")
                let elapsed = Int((ProcessInfo.processInfo.systemUptime - verificationStarted) * 1000)
                diagnostic("Connection-wake blackout stage=\(stage) transition=\(retainedOriginal ? "retainedOriginal" : "capturedOriginal") quietPreparation=\(quietPreparation) profile=\(lightingProfile) elapsedMs=\(elapsed) mainNonblack=\(main.count) sideNonblack=\(side.count) nonblackLEDs=[\(evidence)] state=\(state)")
                return !side.isEmpty
            }
            var sideIndicatorObserved = reportBlackout("initial", rendered, observed)
            // D5 proves configuration, not that the asynchronous rendered D2
            // buffer has caught up after D6. Retry reads only, never an uncertain
            // write, with at most two bounded settling observations.
            let firstObservedAt = ProcessInfo.processInfo.systemUptime
            for delay in [0.05, 0.12] where !nonblackKeys(rendered).isEmpty {
                let remaining = firstObservedAt + delay - ProcessInfo.processInfo.systemUptime
                if remaining > 0 { pump(remaining) }
                rendered = try readRGB()
                observed = try readState()
                try requireOwnedLightingProfile(original.lightingProfile ?? 0)
                sideIndicatorObserved = reportBlackout("settle\(Int(delay * 1000))ms", rendered, observed) || sideIndicatorObserved
            }
            guard nonblackKeys(rendered).isEmpty else {
                throw failure("COLOR_VERIFY_FAILED", "Connection-wake preparation did not verify all \(model.keyCount) main key slots black; diagnostic pixel evidence was retained.")
            }
            guard S4.ownedStateMatches(ready, observed, firmware: firmware, model: model),
                  let durable = backup, try loadBackup() == durable else {
                throw failure("INVALID_BACKUP", "Connection-wake state or its original backup changed before verification.")
            }
            if S4.presetFieldsDiffer(durable.state, observed, firmware: firmware, model: model), presetArchive == nil {
                presetArchive = try journals.preservePresetHistory(durable, serial: serial)
            }
            armed = true; firstPaintVerified = true; lastPaint = black
            return ["armed":true,"verified":true,"state":observed,"backupPath":backupURL.path,
                    "needsRestore":true,"recoveryPending":true,"unsafeWritesNeeded":true,
                    "transition":retainedOriginal ? "retainedOriginal" : "capturedOriginal",
                    "darkBeforeCapture":quietPreparation,"quietPreparation":quietPreparation,"sideMuted":true,
                    // sideMuted describes the verified stock-zone setting.
                    // Firmware-owned side indications may override its pixels;
                    // they do not invalidate a verified black main-key frame.
                    "mainBlackVerified":true,"sideIndicatorObserved":sideIndicatorObserved,
                    "allLightsBlack":rendered.allSatisfy({ $0 == 0 }),
                    "presetHistoryPath":presetArchive?.path ?? ""]
        } catch { throw rollbackError(error) }
    }
    private func writeRGB(_ colors: [UInt8], previous: [UInt8]? = nil) throws {
        try verifyLightingProfileForWrite()
        guard colors.count == model.keyCount * 3 else { throw failure("INVALID_COLORS", "Expected RGB data for \(model.keyCount) keys.") }
        // D8 carries independent index/R/G/B records. Keep the proven 13-record
        // packet size, but do not resend 84 LEDs when only task keys change.
        // First paint, explicit verification and restoration always use a full
        // frame; lastPaint advances only after every packet is acknowledged.
        let changed = (0..<model.keyCount).filter { index in
            guard let previous = previous, previous.count == model.keyCount * 3 else { return true }
            return colors[(index*3)..<(index*3+3)] != previous[(index*3)..<(index*3+3)]
        }
        for start in stride(from: 0, to: changed.count, by: 13) {
            let end = min(start + 13, changed.count)
            var records = [UInt8]()
            for index in changed[start..<end] { records += [UInt8(model.rgbWriteIndices[index])] + Array(colors[(index * 3)..<(index * 3 + 3)]) }
            let echoed = try request(0xd8, length: records.count, payload: records)
            guard echoed == records else { throw failure("COLOR_ACK_MISMATCH", "D8 did not echo the complete indexed RGB records.") }
        }
        lastRGBWriteAt = ProcessInfo.processInfo.systemUptime
    }
    func paint(_ colors: [UInt8], verify: Bool) throws -> [String: Any] {
        guard armed else { throw failure("NOT_ARMED", "Call arm before painting the key LEDs.") }
        guard colors.count == model.canvasCount * 3 || colors.count == model.keyCount * 3 else { throw failure("INVALID_COLORS", "Invalid canvas size.") }
        let colors = Array(colors.prefix(model.keyCount * 3))
        if colors == lastPaint && !verify { return ["painted": model.keyCount, "skipped": true, "verification": "unchanged"] }
        do {
            let fullVerification = verify || !firstPaintVerified
            try writeRGB(colors, previous: fullVerification ? nil : lastPaint)
            if fullVerification {
                let rendered = try readRGB()
                let expected = S4.renderedCustomColors(colors, firmware: firmware, model: model)
                guard Array(rendered.prefix(model.keyCount * 3)) == expected else {
                    let mismatches = expected.indices.filter { rendered[$0] != expected[$0] }
                    diagnostic("D2 verify firmware=\(S4.firmwareVersion(firmware)) mismatchedChannels=\(mismatches.count) samples=\(mismatches.prefix(12).map { "\($0):\(expected[$0])->\(rendered[$0])" }.joined(separator: ","))")
                    throw failure("COLOR_VERIFY_FAILED", "D2 did not show the requested key colors; original lighting will be restored.")
                }
                firstPaintVerified = true
            }
            lastPaint = colors
            return ["painted": model.keyCount, "skipped": false, "verification": fullVerification ? "readback" : "validatedAck"]
        } catch { throw rollbackError(error) }
    }
    // Native effects are available on Kick firmware that predates the D8
    // per-key endpoint. This operation never enters custom mode 21.
    func nativeLighting(_ command: [String:Any]) throws -> [String:Any] {
        try requireConnected()
        guard model == .kick75, protocolReady else { throw failure("NATIVE_LIGHTING_UNSUPPORTED", "此键盘不提供 Kick75 原生灯效控制。") }
        var state = try readState()
        let before = state
        // The official SelfDevKeyboardLightMode enumeration exposes 1...20;
        // mode 0/custom and new mode 21 are deliberately outside this API.
        let stockModes: Set<Int> = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]
        if let value = command["mode"] {
            guard let mode = value as? Int, stockModes.contains(mode) else { throw failure("INVALID_LIGHTING","请选择 Kick75 的官方原生灯效。") }
            state[0] = UInt8(mode)
        }
        for (name,offset,range) in [("brightness",1,0...100),("speed",2,0...4),("direction",3,0...3)] {
            if let value = command[name] {
                guard let number = value as? Int, range.contains(number) else { throw failure("INVALID_LIGHTING","原生灯效参数超出允许范围。") }
                state[offset] = UInt8(number)
            }
        }
        if let value = command["color"] {
            guard let color = value as? String else { throw failure("INVALID_COLOR","Expected an RGB colour.") }
            state.replaceSubrange(6..<9,with:try parseColor(color)); state[4] = 0
        }
        if let value = command["rgb"] {
            guard let rgb = value as? Bool else { throw failure("INVALID_LIGHTING","rgb must be a boolean.") }
            state[4] = rgb ? 1 : 0
        }
        guard (1...20).contains(Int(state[0])) else { throw failure("INVALID_LIGHTING","请选择 Kick75 的官方原生灯效。") }
        if state == before { return ["verified":true,"changed":false,"state":state,"armed":false,"needsRestore":recoveryPending,"recoveryPending":recoveryPending] }
        try ensureBackup(requirePerKey:false)
        mutationAttempted = true
        do {
            try writeStateVerified(state)
            armed = false; firstPaintVerified = false; lastPaint = nil
            return ["verified":true,"changed":true,"state":try readState(),"armed":false,"needsRestore":true,"recoveryPending":true,"backupPath":backupURL.path]
        } catch { throw rollbackError(error) }
    }
    func setSide(color: [UInt8], brightness: Int) throws -> [String: Any] {
        guard color.count == 3, (0...100).contains(brightness) else { throw failure("INVALID_SIDE", "side brightness must be an integer from 0 to 100.") }
        var state = try readState()
        state[9] = 2; state[10] = UInt8(brightness); state[12] = 0; state[13] = 0
        state.replaceSubrange(14..<17, with: color)
        if S4.statesMatch(state, try readState(), firmware: firmware, model: model) { return ["sideIndependent": false, "changed": false, "state": state] }
        try ensureBackup(requirePerKey: false)
        mutationAttempted = true
        do {
            try writeStateVerified(state)
            return ["sideIndependent": false, "changed": true, "state": state, "verified": true]
        } catch { throw rollbackError(error) }
    }
    func restoreSide() throws -> [String: Any] {
        _ = try requireConnected()
        guard let saved = backup else { return ["changed": false, "reason": "noBackup", "sideIndependent": false] }
        var state = try readState()
        state.replaceSubrange(9..<17, with: saved.state[9..<17])
        if S4.statesMatch(state, try readState(), firmware: firmware, model: model) { return ["changed": false, "state": state, "sideIndependent": false] }
        mutationAttempted = true
        do {
            try writeStateVerified(state)
            return ["changed": true, "restored": true, "verified": true, "state": state, "sideIndependent": false]
        } catch { throw rollbackError(error) }
    }
    private func rollbackError(_ original: Error) -> BridgeError {
        if let error = original as? BridgeError, error.code == "LIGHTING_PROFILE_CHANGED" { return error }
        do {
            _ = try restore()
            return failure((original as? BridgeError)?.code ?? "LIGHTING_FAILED", "\(original). Original lighting was restored and verified.")
        } catch {
            return failure("RESTORE_REQUIRED", "Lighting operation failed: \(original). Restoration also failed: \(error). Backup retained at \(backupURL.path).")
        }
    }
    func restore() throws -> [String: Any] {
        // Sleep can be the only mutation (for example, a failed RGB arm).
        // Release it even when there is no lighting journal to restore.
        var sleepResult: [String:Any] = [:]
        var sleepFailure: Error?
        do { sleepResult = try releaseBoardSleepLease() }
        catch { sleepFailure = error }
        if !connected, hasPendingBackups { _ = try connect() }
        if connected && !protocolReady {
            throw compatibilityError ?? failure("UNSUPPORTED_PROTOCOL","键盘兼容性尚未确认，恢复备份已保留，未修改键盘设置。")
        }
        else if connected { try identify(); _ = try readState(); try selectRecoveryProfile() }
        guard recoveryPending else {
            if let error = sleepFailure { throw error }
            return ["restored": sleepResult["restored"] as? Bool ?? false, "reason": "noBackupForCurrentProfile", "verified": true, "needsRestore": false, "recoveryPending": false, "deferredProfiles": deferredProfiles,"boardSleepLease":boardSleepLeaseStatus,"sleepRestoration":sleepResult]
        }
        let saved: LightingBackup
        if let current = backup { saved = current } else { saved = try loadBackup(); backup = saved }
        try verifyLightingProfileForWrite()
        guard Array(saved.firmware.prefix(6)) == Array(firmware.prefix(6)) else {
            throw failure("BACKUP_FIRMWARE_MISMATCH", "Firmware changed since the backup. Refusing to restore an unverified configuration.")
        }
        let initialState = try readState()
        var presetArchive: URL?
        if S4.presetFieldsDiffer(saved.state, initialState, firmware: firmware, model: model) {
            // These fields are not leased by NuPhyLab. Preserve the exact old
            // journal durably, then leave the keyboard's current preset alone.
            // An archival failure leaves the active backup and stops all writes.
            presetArchive = try journals.preservePresetHistory(saved, serial: serial)
            diagnostic("Preset fields preserved firmware=\(S4.firmwareVersion(firmware)) saved=\(Array(saved.state.suffix(5))) current=\(Array(initialState.suffix(5))) archive=\(presetArchive!.path)")
        }
        mutationAttempted = true
        if model == .air75 && saved.state.count == 17 && saved.state[0] == 21 {
            guard saved.state[1] == 100 else { throw failure("CUSTOM_BACKUP_LOSSY", "Cannot exactly restore a dimmed custom framebuffer.") }
        }
        let custom = saved.customColors ?? (saved.state[0] == 21 ? Array(saved.renderedColors.prefix(model.keyCount * 3)) : nil)
        if let colors = custom {
            var current = try readState()
            var fullPalette = current
            fullPalette[0] = 21; fullPalette[1] = 100; fullPalette[4] = 1
            if current.count == 22 { fullPalette.replaceSubrange(6..<9, with: [255,255,255]) }
            if current != fullPalette {
                current = fullPalette
                try writeStateVerified(fullPalette)
            }
            try writeRGB(colors)
            // The inspected new firmware debounces palette persistence for
            // one second. Leave that idle window before completing recovery.
            if model == .air75 && saved.customColors != nil { pump(1.15) }
            guard Array(try readRGB().prefix(model.keyCount * 3)) == S4.renderedCustomColors(colors, firmware: firmware, model: model) else {
                throw failure("RESTORE_COLOR_MISMATCH", "The original custom palette did not verify. Backup retained.")
            }
        }
        var target = S4.restoreTarget(saved.state)
        let restoresOff = target != saved.state
        if restoresOff, S4.ownedStateMatches(saved.state, try readState(), firmware: firmware, model: model) {
            // A rejected arm may have left the board switched off throughout.
            // No write is needed to restore an already unchanged state.
            target = saved.state
        } else { try writeStateVerified(target) }
        if restoresOff {
            let rendered = try readRGB()
            guard rendered.allSatisfy({ $0 == 0 }) else {
                throw failure("RESTORE_COLOR_MISMATCH", "The prior off state did not render completely dark. Backup retained.")
            }
        }
        if saved.state[0] == 21 {
            pump(0.04)
            var actual = try readRGB()
            if let captured = saved.customColors, saved.state.count == 22,
               Array(actual.prefix(model.keyCount * 3)) != Array(saved.renderedColors.prefix(model.keyCount * 3)) {
                // D2 is quantized. Try the other end of each identical-output
                // interval only where the original dimmed output needs it.
                let full = S4.renderedCustomColors(captured, firmware: firmware, model: model)
                let upper = try S4.paletteFromRendered(full, firmware: firmware, high: true, model: model)
                var adjusted = captured
                for i in adjusted.indices where actual[i] != saved.renderedColors[i] { adjusted[i] = upper[i] }
                try writeRGB(adjusted); pump(1.15)
                actual = try readRGB()
            }
            guard Array(actual.prefix(model.keyCount * 3)) == Array(saved.renderedColors.prefix(model.keyCount * 3)) else {
                throw failure("RESTORE_COLOR_MISMATCH", "State restored, but the prior custom key colors did not verify. Backup retained.")
            }
        }
        let observed = try readState()
        guard S4.ownedStateMatches(target, observed, firmware: firmware, model: model) else {
            throw failure("RESTORE_STATE_MISMATCH", "Lighting state changed during restoration. Backup retained.")
        }
        if S4.presetFieldsDiffer(saved.state, observed, firmware: firmware, model: model), presetArchive == nil {
            // Includes drift while restoration was in progress. The original
            // remains active until this second durable archive check succeeds.
            presetArchive = try journals.preservePresetHistory(saved, serial: serial)
            diagnostic("Preset fields changed during scoped restore; original preserved at \(presetArchive!.path)")
        }
        // A moving stock effect does not reproduce an old frame. Verify every
        // owned main/side field, plus D2 for original custom/off output. Preset
        // fields were never written and any differing original stays archived.
        guard try loadBackup() == saved else {
            throw failure("INVALID_BACKUP", "The active backup changed during restoration; retained for review.")
        }
        do { try FileManager.default.removeItem(at: backupURL) }
        catch { throw failure("BACKUP_CLEANUP_FAILED", "Lighting is verified restored, but the backup could not be removed: \(error.localizedDescription)") }
        backup = nil; mutationAttempted = false; armed = false; firstPaintVerified = false; lastPaint = nil
        if let error = sleepFailure { throw error }
        return ["restored": true, "verified": true, "state": observed, "needsRestore": false, "recoveryPending": false, "deferredProfiles": deferredProfiles,
                "boardSleepLease":boardSleepLeaseStatus,"sleepRestoration":sleepResult,
                "verification": restoresOff ? "allLightsOff" : (saved.state[0] == 21 ? "ownedStateAndCustomColors" : "ownedMainAndSideState"),
                "presetParametersPreserved": saved.state.count == 22,
                "presetHistoryPath": presetArchive?.path ?? ""]
    }
    func disconnect() throws -> [String: Any] {
        var restored: [String: Any] = ["restored": false]
        var sleepRestored: [String: Any] = ["restored":false,"verified":true]
        if boardSleepLeasePending {
            do { sleepRestored = try releaseBoardSleepLease() }
            catch { sleepRestored = ["restored":false,"verified":false,"error":String(describing:error)];diagnostic("Board sleep recovery deferred on disconnect: \(error)") }
        }
        if !protocolReady {
            let pending=recoveryPending,keysPending=hasFunctionKeyBackup || hasLostFunctionKeyRecovery,owned=mutationAttempted || ownsFunctionKeyChanges
            let unownedHistory=hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery,lost=hasLostFunctionKeyRecovery
            closeTransport()
            return ["connected":false,"identified":false,"firmwareDetectionAvailable":false,"armed":false,"readOnly":true,"protocolReady":false,
                    "restoration":["restored":false,"verified":!owned,"reason":"readOnly","writesPerformed":false],
                    "recoveryPending":pending,"needsRestore":pending,"unsafeWritesNeeded":owned || sleepMutationAttempted,"functionKeyRecoveryPending":keysPending,
                    "boardSleepLease":boardSleepLeaseStatus,"sleepRestoration":sleepRestored,
                    "unownedFunctionKeyHistory":unownedHistory,"historicalRecoveryLost":lost]
        }
        let functionKeyOwned=ownsFunctionKeyChanges
        let unownedHistory=hasFunctionKeyBackup && !ownsCurrentFunctionKeyLease && !hasLostFunctionKeyRecovery
        // A failed restore must not trap the USB handle open. Keep the durable
        // journal and explicitly report deferred restoration after releasing it.
        if recoveryPending {
            do { restored = try restore() }
            catch { restored = ["restored": false, "verified": false, "error": String(describing: error)]; diagnostic("Disconnect recovery deferred: \(error)") }
        }
        closeTransport()
        return ["connected": false, "identified": false, "firmwareDetectionAvailable": false,
                "readOnly": true, "protocolReady": false, "armed": false, "restoration": restored,
                "recoveryPending": recoveryPending, "needsRestore": recoveryPending,
                "unsafeWritesNeeded": mutationAttempted || functionKeyOwned || sleepMutationAttempted,
                "boardSleepLease":boardSleepLeaseStatus,"sleepRestoration":sleepRestored,
                "functionKeyRecoveryPending": hasFunctionKeyBackup || hasLostFunctionKeyRecovery,
                "unownedFunctionKeyHistory":unownedHistory,
                "historicalRecoveryLost":hasLostFunctionKeyRecovery]
    }
    func shutdown() -> Bool {
        var ok = true
        if boardSleepLeasePending {
            do {
                if !connected {
                    // A fresh offline helper has no live serial/firmware. That
                    // is not corruption of a valid original from a prior run.
                    // An owned/previously identified session still has to match
                    // its original, and neither branch opens or writes a device.
                    let neverIdentified = serial.isEmpty && firmware.isEmpty &&
                        !sleepMutationAttempted && sleepLeaseOriginal == nil
                    let saved = try neverIdentified ? boardSleepJournal.readRetained() :
                        boardSleepJournal.read(serial:serial,firmware:firmware)
                    if let owned = sleepLeaseOriginal, owned != saved {
                        throw failure("SLEEP_BACKUP_CHANGED", "The owned board sleep original changed; it has been retained.")
                    }
                    emit(["event":"boardSleepRestoreDeferred","reason":"disconnected","deviceIdentityVerified":!neverIdentified,"backupPath":boardSleepJournal.url.path])
                } else {
                    emit(["event":"boardSleepRestoredOnExit","result":try releaseBoardSleepLease()])
                }
            } catch { ok = false;diagnostic("BOARD SLEEP RESTORE REQUIRED: \(error)");emit(["event":"boardSleepRestoreFailed","error":String(describing:error),"backupPath":boardSleepJournal.url.path]) }
        }
        if mutationAttempted {
            do {
                if !connected {
                    // USB removal makes restoration impossible. A validated
                    // durable journal is a safe deferred exit, not a restore.
                    let saved = try backup ?? loadBackup()
                    let retainedURL = journals.url(saved.lightingProfile ?? 0)
                    _ = try journals.read(retainedURL, serial: serial)
                    emit(["event": "restoreDeferred", "reason": "disconnected", "backupPath": retainedURL.path])
                } else {
                    let result = try restore(); emit(["event": "restoredOnExit", "result": result])
                }
            }
            catch { ok = false; diagnostic("RESTORE REQUIRED: \(error)"); emit(["event": "restoreFailed", "error": String(describing: error), "backupPath": backupURL.path]) }
        }
        closeTransport()
        return ok
    }
}


struct KeyBinding: Sendable {
    let name: String
    let code: Int
    let flags: CGEventFlags
    let suppress: Bool
}

// A global hold needs real modifier transitions as well as a keyDown/keyUp.
// Codex's native release watcher observes the global event stream; posting an
// up directly to one PID leaves that watcher holding the shortcut forever.
struct ShortcutChord: Sendable {
    struct Step: Sendable {
        let code: CGKeyCode
        let type: CGEventType
        let flags: CGEventFlags
    }
    static let modifiers: [(CGEventFlags, CGKeyCode)] = [(.maskControl,59),(.maskShift,56),(.maskAlternate,58),(.maskCommand,55),(.maskSecondaryFn,63)]
    let down: [Step]
    let up: [Step]
    init(code: CGKeyCode, flags: CGEventFlags, modifierOnly: Bool, alreadyHeld: CGEventFlags) {
        var current = alreadyHeld
        var press = [Step](), release = [Step]()
        let owned = Self.modifiers.filter { flags.contains($0.0) && !alreadyHeld.contains($0.0) }
        for (flag,key) in owned {
            current.insert(flag); press.append(Step(code:key,type:.flagsChanged,flags:current))
        }
        if !modifierOnly {
            press.append(Step(code:code,type:.keyDown,flags:current))
            release.append(Step(code:code,type:.keyUp,flags:current))
        }
        for (flag,key) in owned.reversed() {
            current.remove(flag); release.append(Step(code:key,type:.flagsChanged,flags:current))
        }
        down = press; up = release
    }
}
final class KeyHooks {
    private struct HeldShortcut {
        let code: CGKeyCode
        let flags: CGEventFlags
        let pid: pid_t
        let globalRelease: [CGEvent]?
    }
    private var heldShortcut: HeldShortcut?
    private var releaseTimer: DispatchWorkItem?
    @discardableResult func releaseShortcut() -> Bool {
        releaseTimer?.cancel(); releaseTimer = nil
        guard let held = heldShortcut else { return false }
        heldShortcut = nil
        if let events = held.globalRelease {
            for event in events { event.post(tap:.cghidEventTap) }
        } else if let up = CGEvent(keyboardEventSource: nil, virtualKey: held.code, keyDown: false) {
            up.flags = held.flags
            // Finish only in the original app, even when the user changed focus.
            up.postToPid(held.pid)
        }
        return true
    }
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var bindings = [KeyBinding]()
    // Only the agreed Ctrl+Option+1…6 and Ctrl+Option+N combinations.
    // Arrow keys belong to the editor's focused game view, never a global tap.
    static let allowedMonitorCodes: Set<Int> = [18,19,20,21,23,22,45]
    static let modifierMask: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]
    static func flags(_ names: Any?) throws -> CGEventFlags {
        guard names == nil || names is [String] else { throw failure("INVALID_MODIFIERS", "modifiers must be an array of command, shift, option, control or fn.") }
        var result: CGEventFlags = []
        for name in names as? [String] ?? [] {
            switch name.lowercased() {
            case "command", "cmd": result.insert(.maskCommand)
            case "shift": result.insert(.maskShift)
            case "option", "alt": result.insert(.maskAlternate)
            case "control", "ctrl": result.insert(.maskControl)
            case "fn": result.insert(.maskSecondaryFn)
            default: throw failure("INVALID_MODIFIERS", "Unknown modifier: \(name)")
            }
        }
        return result
    }
    func stop() {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil; bindings = []
    }
    func configure(_ command: [String: Any]) throws -> [String: Any] {
        if command["enabled"] as? Bool == false { stop(); return ["enabled": false] }
        let defaultBindings: [[String: Any]] = [18,19,20,21,23,22].enumerated().map {
            ["name": "slot-\($0.offset)", "keyCode": $0.element, "modifiers": ["control", "option"], "suppress": false]
        } + [["name": "newTask", "keyCode": 45, "modifiers": ["control", "option"], "suppress": false]]
        let raw = command["bindings"] as? [[String: Any]] ?? defaultBindings
        guard !raw.isEmpty, raw.count <= 7 else { throw failure("INVALID_BINDINGS", "At most seven agreed Control+Option bindings are supported.") }
        var configured = [KeyBinding]()
        for binding in raw {
            guard let code = binding["keyCode"] as? Int, Self.allowedMonitorCodes.contains(code),
                  let name = binding["name"] as? String, !name.isEmpty, name.count <= 80 else {
                throw failure("INVALID_BINDING", "A binding requires name and a macOS keyCode for 1–6 or N.")
            }
            let flags = try Self.flags(binding["modifiers"])
            guard flags == [.maskControl, .maskAlternate] else {
                throw failure("INVALID_BINDING", "Global monitoring is limited to Control+Option+1–6 / N; bare typing keys are forbidden.")
            }
            guard !configured.contains(where: { $0.code == code && $0.flags == flags }) else {
                throw failure("DUPLICATE_BINDING", "Two bindings have the same key and modifiers.")
            }
            configured.append(KeyBinding(name: name, code: code, flags: flags, suppress: binding["suppress"] as? Bool ?? false))
        }
        stop()
        let context = Unmanaged.passUnretained(self).toOpaque()
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        guard let newTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                             options: configured.contains(where: { $0.suppress }) ? .defaultTap : .listenOnly,
                                             eventsOfInterest: mask, callback: { _, type, event, context in
            guard let context = context else { return Unmanaged.passUnretained(event) }
            return Unmanaged<KeyHooks>.fromOpaque(context).takeUnretainedValue().handle(type, event)
        }, userInfo: context) else {
            throw failure("INPUT_MONITORING_REQUIRED", "macOS denied the key monitor. Enable Input Monitoring for the parent application; suppression may also require Accessibility.")
        }
        bindings = configured; tap = newTap
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0)
        if let source = source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        CGEvent.tapEnable(tap: newTap, enable: true)
        return ["enabled": true, "bindingCount": bindings.count, "ordinaryTypingRecorded": false]
    }
    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let flags = event.flags.intersection(Self.modifierMask)
        guard let binding = bindings.first(where: { $0.code == code && $0.flags == flags }) else {
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            if code == 45 { emit(["event": "shortcut", "action": "newTask"]) }
            else if let index = [18,19,20,21,23,22].firstIndex(of: code) {
                emit(["event": "shortcut", "action": "slot", "index": index])
            }
        }
        return binding.suppress ? nil : Unmanaged.passUnretained(event)
    }
    func shortcut(_ command: [String: Any]) throws -> [String: Any] {
        let phase = command["phase"] as? String ?? "tap"
        guard ["tap", "down", "up"].contains(phase) else { throw failure("INVALID_SHORTCUT", "Invalid shortcut phase.") }
        if phase == "up" { return ["released": releaseShortcut()] }
        if command["action"] as? String == "task" {
            releaseShortcut()
            guard let threadID = command["threadId"] as? String, (1...160).contains(threadID.count),
                  threadID.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-").contains($0) }),
                  let url = URL(string: "codex://threads/\(threadID)") else {
                throw failure("INVALID_TASK", "threadId must contain only letters, digits, underscores and hyphens.")
            }
            guard NSWorkspace.shared.open(url) else { throw failure("TASK_OPEN_FAILED", "macOS could not open the Codex task URL.") }
            return ["opened": true, "threadId": threadID]
        }
        guard let code = command["keyCode"] as? Int, (0...127).contains(code) else {
            throw failure("INVALID_SHORTCUT", "shortcut requires a macOS virtual keyCode from 0 to 127.")
        }
        let flags = try Self.flags(command["modifiers"])
        let target = command["target"] as? String ?? "com.openai.codex"
        guard target == "com.openai.codex" else { throw failure("INVALID_TARGET", "Shortcut delivery is limited to the Codex application.") }
        if command["activateTarget"] as? Bool == true,
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier != target {
            guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: target).first else {
                throw failure("TARGET_NOT_RUNNING", "Open Codex before sending a shortcut.")
            }
            app.activate(options: [])
            let deadline = ProcessInfo.processInfo.systemUptime + 1.0
            while NSWorkspace.shared.frontmostApplication?.bundleIdentifier != target && ProcessInfo.processInfo.systemUptime < deadline { pump(0.02) }
        }
        guard let targetApp = NSWorkspace.shared.frontmostApplication, targetApp.bundleIdentifier == target else {
            throw failure("TARGET_NOT_FRONTMOST", "Codex did not become the foreground application; no shortcut was sent.")
        }
        guard CGPreflightPostEventAccess() else { throw failure("ACCESSIBILITY_REQUIRED", "Enable Accessibility for the parent application to send shortcuts.") }
        releaseShortcut()
        if let delivery = command["delivery"] as? String, ["globalHold","globalTap"].contains(delivery) {
            guard phase == (delivery == "globalHold" ? "down" : "tap") else { throw failure("INVALID_SHORTCUT", "Invalid global dictation gesture.") }
            let modifierOnly = command["modifierOnly"] as? Bool == true
            guard !modifierOnly || !flags.isEmpty else { throw failure("INVALID_SHORTCUT", "A modifier hold requires at least one modifier.") }
            let heldFlags = CGEventSource.flagsState(.combinedSessionState).intersection([.maskControl,.maskShift,.maskAlternate,.maskCommand,.maskSecondaryFn])
            let chord = ShortcutChord(code:CGKeyCode(code),flags:flags,modifierOnly:modifierOnly,alreadyHeld:heldFlags)
            let source = CGEventSource(stateID:.privateState)
            func events(_ steps:[ShortcutChord.Step]) throws -> [CGEvent] {
                try steps.map { step in
                    guard let event = CGEvent(keyboardEventSource:source,virtualKey:step.code,keyDown:step.type != .keyUp) else {
                        throw failure("SHORTCUT_FAILED", "macOS could not construct the dictation gesture.")
                    }
                    event.type=step.type; event.flags=step.flags
                    return event
                }
            }
            // Allocate the entire release before posting any part of the press.
            let down = try events(chord.down), up = try events(chord.up)
            if delivery == "globalHold" {
                heldShortcut = HeldShortcut(code:CGKeyCode(code),flags:flags,pid:targetApp.processIdentifier,globalRelease:up)
                for event in down { event.post(tap:.cghidEventTap) }
                let timer = DispatchWorkItem { [weak self] in self?.releaseShortcut() }
                releaseTimer=timer; DispatchQueue.main.asyncAfter(deadline:.now()+120,execute:timer)
            } else {
                for event in down + up { event.post(tap:.cghidEventTap) }
            }
            return ["sent":true,"keyCode":code,"phase":phase,"delivery":delivery]
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: false) else {
            throw failure("SHORTCUT_FAILED", "macOS could not construct the shortcut events.")
        }
        down.flags = flags; up.flags = flags
        down.post(tap: .cgSessionEventTap)
        if phase == "down", let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
            heldShortcut = HeldShortcut(code:CGKeyCode(code),flags:flags,pid:pid,globalRelease:nil)
            let timer = DispatchWorkItem { [weak self] in self?.releaseShortcut() }
            releaseTimer = timer
            DispatchQueue.main.asyncAfter(deadline: .now()+120, execute: timer)
        } else { up.post(tap: .cgSessionEventTap) }
        return ["sent": true, "keyCode": code, "phase": phase]
    }
}

// An explicit lighting trigger is separate from the fixed Codex shortcuts.
// This observer emits only the selected physical key code, never text or other
// keystrokes, and cannot suppress or replace the original keyboard event.
final class TriggerHooks {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var keyCode: Int?
    // Keep this allowlist aligned with shared/trigger-keys.json. Modifier keys,
    // Fn and the encoder are deliberately excluded from the keyDown observer.
    static let allowedCodes: Set<Int> = [
        0,1,2,3,4,5,6,7,8,9,11,12,13,14,15,16,17,18,19,20,21,22,23,24,
        25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,
        45,46,47,48,49,50,51,53,96,97,98,99,100,101,103,109,111,
        114,115,116,117,118,119,120,121,122,123,124,125,126
    ]
    static func requestedCode(_ command: [String: Any]) throws -> Int? {
        guard let enabledValue = command["enabled"] as? NSNumber,
              CFGetTypeID(enabledValue) == CFBooleanGetTypeID() else {
            throw failure("INVALID_TRIGGER_MONITOR", "triggerMonitor requires enabled: true or false.")
        }
        if !enabledValue.boolValue { return nil }
        guard let number = command["keyCode"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == Double(number.intValue),
              Self.allowedCodes.contains(number.intValue) else {
            throw failure("INVALID_TRIGGER_KEY", "Choose one supported physical keyboard key for the lighting trigger.")
        }
        guard command["suppress"] == nil, command["modifiers"] == nil else {
            throw failure("INVALID_TRIGGER_MONITOR", "The lighting trigger observes one unmodified key and cannot suppress input.")
        }
        return number.intValue
    }
    static func shouldTrigger(type: CGEventType, code: Int, flags: CGEventFlags,
                              autorepeat: Int64, configuredCode: Int?) -> Bool {
        type == .keyDown && configuredCode == code && autorepeat == 0 &&
            flags.intersection(KeyHooks.modifierMask).isEmpty
    }
    func stop() {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil; keyCode = nil
    }
    func configure(_ command: [String: Any]) throws -> [String: Any] {
        let requestedCode = try Self.requestedCode(command)
        stop()
        guard let requestedCode = requestedCode else {
            return ["enabled": false, "ordinaryTypingRecorded": false]
        }
        let context = Unmanaged.passUnretained(self).toOpaque()
        let mask = CGEventMask(1) << CGEventType.keyDown.rawValue
        guard let newTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                             options: .listenOnly, eventsOfInterest: mask,
                                             callback: { _, type, event, context in
            if let context = context {
                Unmanaged<TriggerHooks>.fromOpaque(context).takeUnretainedValue().handle(type, event)
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context) else {
            throw failure("INPUT_MONITORING_REQUIRED", "macOS denied the lighting trigger observer. Input Monitoring permission is required for the parent application.")
        }
        guard let newSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else {
            CFMachPortInvalidate(newTap)
            throw failure("TRIGGER_MONITOR_FAILED", "macOS could not attach the lighting trigger observer.")
        }
        keyCode = requestedCode; tap = newTap; source = newSource
        CFRunLoopAddSource(CFRunLoopGetMain(), newSource, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        return ["enabled": true, "ordinaryTypingRecorded": false]
    }
    private func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        if Self.shouldTrigger(type: type, code: code, flags: event.flags,
                              autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat),
                              configuredCode: keyCode) {
            emit(["event": "triggerKey", "keyCode": code])
        }
    }
}


// MARK: - DSH JSON-RPC 2.0 Peripheral Engine & 84-Key Codex Micro Renderer

enum DshAgentStatus: String, Codable, Sendable, CaseIterable {
    case inactive = "INACTIVE"
    case idle = "IDLE"
    case running = "RUNNING"
    case needsInput = "NEEDS_INPUT"
    case completed = "COMPLETED"
    case error = "ERROR"

    /// Official Codex Micro RGB status palette (see docs/spec/nuphy-s4-whitepaper.md §6.2)
    var rgb: (UInt8, UInt8, UInt8) {
        switch self {
        case .inactive:   return (0x00, 0x00, 0x00) // #000000
        case .idle:       return (0xFF, 0xFF, 0xFF) // #FFFFFF
        case .running:    return (0x30, 0x4F, 0xFE) // #304FFE
        case .needsInput: return (0xFF, 0x6D, 0x00) // #FF6D00
        case .completed:  return (0x00, 0xFF, 0x4C) // #00FF4C
        case .error:      return (0xFF, 0x00, 0x33) // #FF0033
        }
    }
}

enum DshBrainpowerLevel: String, Codable, Sendable, CaseIterable {
    case low = "low"
    case medium = "medium"
    case high = "high"
    case max = "max"
}

struct DshSlotQuestion: Codable, Sendable, Equatable {
    let prompt: String
    let options: [String]
}

struct DshSlotInfo: Codable, Sendable, Equatable {
    let slotIndex: Int
    var sessionId: String?
    var status: DshAgentStatus
    var brainpower: DshBrainpowerLevel?
    var activeTool: String?
    var question: DshSlotQuestion?

    static func fromDictionary(_ dict: [String: Any]) throws -> DshSlotInfo {
        guard let slotIndex = dict["slotIndex"] as? Int, (1...12).contains(slotIndex) else {
            throw failure("INVALID_SLOT", "slotIndex must be an integer from 1 to 12.")
        }
        let statusRaw = (dict["status"] as? String ?? "INACTIVE").uppercased()
        guard let status = DshAgentStatus(rawValue: statusRaw) else {
            throw failure("INVALID_STATUS", "Unrecognized DSH slot status: \(statusRaw)")
        }
        let sessionId = dict["sessionId"] as? String
        let brainpower = (dict["brainpower"] as? String).flatMap { DshBrainpowerLevel(rawValue: $0.lowercased()) }
        let activeTool = dict["activeTool"] as? String
        var question: DshSlotQuestion? = nil
        if let qDict = dict["question"] as? [String: Any],
           let prompt = qDict["prompt"] as? String,
           let options = qDict["options"] as? [String] {
            question = DshSlotQuestion(prompt: prompt, options: options)
        }
        return DshSlotInfo(
            slotIndex: slotIndex,
            sessionId: sessionId,
            status: status,
            brainpower: brainpower,
            activeTool: activeTool,
            question: question
        )
    }
}

enum DshFrameRenderer {
    static let ledCount = 84
    static let frameByteCount = 252 // 84 * 3
    // Air75 V3 ANSI physical LED indices (from shared/air75-v3-ansi.json)
    static let escLedIndex = 0
    static let fKeyLedIndices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] // F1..F12
    static let optionNumberLedIndices = [16, 17, 18, 19] // 1, 2, 3, 4
    static let yesKeyLedIndex = 36   // Y
    static let enterKeyLedIndex = 57 // Enter
    static let noKeyLedIndex = 65    // N

    static func scaleRGB(_ rgb: (UInt8, UInt8, UInt8), factor: Double) -> (UInt8, UInt8, UInt8) {
        let clamped = max(0.0, min(1.0, factor))
        let r = UInt8(min(255, max(0, Int((Double(rgb.0) * clamped).rounded()))))
        let g = UInt8(min(255, max(0, Int((Double(rgb.1) * clamped).rounded()))))
        let b = UInt8(min(255, max(0, Int((Double(rgb.2) * clamped).rounded()))))
        return (r, g, b)
    }

    /// Official 1800ms cosine breathing waveform for selected/focused task key
    static func pulseFactor(elapsedMs: Double, periodMs: Double = 1800.0) -> Double {
        0.28 + 0.72 * (0.5 + 0.5 * cos((elapsedMs / periodMs) * Double.pi * 2.0))
    }

    static func setLed(_ buffer: inout [UInt8], index: Int, rgb: (UInt8, UInt8, UInt8)) {
        guard (0..<ledCount).contains(index), index != 83 else { return } // Index 83 is unmapped reserved slot
        let offset = index * 3
        buffer[offset] = rgb.0
        buffer[offset + 1] = rgb.1
        buffer[offset + 2] = rgb.2
    }

    static func composeFrame(
        slots: [DshSlotInfo],
        focusedSlot: Int,
        elapsedMs: Double = 0.0,
        brightness: Double = 1.0,
        pulseFocused: Bool = true
    ) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: frameByteCount)
        let byIndex = Dictionary(uniqueKeysWithValues: slots.filter { (1...12).contains($0.slotIndex) }.map { ($0.slotIndex, $0) })

        for slotIndex in 1...12 {
            let ledIndex = fKeyLedIndices[slotIndex - 1]
            guard let slot = byIndex[slotIndex], slot.status != .inactive else {
                setLed(&out, index: ledIndex, rgb: (0, 0, 0))
                continue
            }
            let isFocused = (slotIndex == focusedSlot)
            let scale: Double
            if isFocused {
                scale = brightness * (pulseFocused ? pulseFactor(elapsedMs: elapsedMs) : 1.0)
            } else if slot.status == .idle {
                scale = brightness * 0.35
            } else {
                scale = brightness
            }
            setLed(&out, index: ledIndex, rgb: scaleRGB(slot.status.rgb, factor: scale))
        }

        // Highlight quick-response decision keys when the focused slot requires user approval/input
        if let focused = byIndex[focusedSlot], focused.status == .needsInput {
            let pulse = pulseFocused ? pulseFactor(elapsedMs: elapsedMs, periodMs: 900.0) : 1.0
            let acceptRgb = scaleRGB(DshAgentStatus.completed.rgb, factor: brightness * pulse)
            let rejectRgb = scaleRGB(DshAgentStatus.error.rgb, factor: brightness * pulse)
            let optionRgb = scaleRGB(DshAgentStatus.needsInput.rgb, factor: brightness * pulse)

            setLed(&out, index: enterKeyLedIndex, rgb: acceptRgb)
            setLed(&out, index: yesKeyLedIndex, rgb: acceptRgb)
            setLed(&out, index: escLedIndex, rgb: rejectRgb)
            setLed(&out, index: noKeyLedIndex, rgb: rejectRgb)

            let optionCount = min(optionNumberLedIndices.count, max(3, focused.question?.options.count ?? 3))
            for i in 0..<optionCount {
                setLed(&out, index: optionNumberLedIndices[i], rgb: optionRgb)
            }
        }

        return out
    }

    static func sideBarTarget(slots: [DshSlotInfo], focusedSlot: Int) -> (color: [UInt8], brightness: Int) {
        guard let focused = slots.first(where: { $0.slotIndex == focusedSlot }),
              focused.status != .inactive else {
            return ([0, 0, 0], 0)
        }
        let (r, g, b) = focused.status.rgb
        let brightness = (focused.status == .idle) ? 25 : 60
        return ([r, g, b], brightness)
    }
}

final class DshJsonRpcSession {
    enum IncomingAction: Equatable {
        case none
        case renderRequired(sideChanged: Bool)
        case serverShuttingDown
        case rpcResponse(id: Int, ok: Bool)
    }

    private(set) var slotsByIndex = [Int: DshSlotInfo]()
    private(set) var focusedSlot: Int = 1
    private(set) var focusSelectedAtMs: Double = 0.0
    private var nextRequestId: Int = 1

    var orderedSlots: [DshSlotInfo] {
        (1...12).map { index in
            slotsByIndex[index] ?? DshSlotInfo(
                slotIndex: index,
                sessionId: nil,
                status: .inactive,
                brainpower: .medium,
                activeTool: nil,
                question: nil
            )
        }
    }

    var hasActiveSlots: Bool {
        slotsByIndex.values.contains { $0.status != .inactive }
    }

    var shouldPulseFocusedSlot: Bool {
        guard let focused = slotsByIndex[focusedSlot] else { return false }
        switch focused.status {
        case .running, .needsInput, .error:
            return true
        case .inactive, .idle, .completed:
            return false
        }
    }

    func handleIncomingJson(_ text: String, nowMs: Double = ProcessInfo.processInfo.systemUptime * 1000.0) throws -> IncomingAction {
        guard let data = text.data(using: .utf8),
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["jsonrpc"] as? String) == "2.0" else {
            throw failure("INVALID_JSONRPC", "Message is not a valid JSON-RPC 2.0 object.")
        }

        if let method = obj["method"] as? String {
            let params = obj["params"] as? [String: Any] ?? [:]
            switch method {
            case "peripheral/snapshot":
                slotsByIndex.removeAll()
                if let focus = params["focusedSlot"] as? Int, (1...12).contains(focus) {
                    focusedSlot = focus
                }
                if let rawSlots = params["slots"] as? [[String: Any]] {
                    for raw in rawSlots {
                        let slot = try DshSlotInfo.fromDictionary(raw)
                        slotsByIndex[slot.slotIndex] = slot
                    }
                }
                focusSelectedAtMs = nowMs
                return .renderRequired(sideChanged: true)

            case "peripheral/slotUpdated":
                let slot = try DshSlotInfo.fromDictionary(params)
                slotsByIndex[slot.slotIndex] = slot
                return .renderRequired(sideChanged: slot.slotIndex == focusedSlot)

            case "peripheral/focusChanged":
                guard let focus = params["focusedSlot"] as? Int, (1...12).contains(focus) else {
                    throw failure("INVALID_FOCUS", "focusedSlot must be between 1 and 12.")
                }
                focusedSlot = focus
                focusSelectedAtMs = nowMs
                return .renderRequired(sideChanged: true)

            case "peripheral/serverShuttingDown":
                slotsByIndex.removeAll()
                return .serverShuttingDown

            default:
                return .none
            }
        }

        if let id = obj["id"] as? Int {
            let isOk = (obj["error"] == nil)
            return .rpcResponse(id: id, ok: isOk)
        }

        return .none
    }

    func buildSwitchFocusRequest(slotIndex: Int) throws -> String {
        guard (1...12).contains(slotIndex) else {
            throw failure("INVALID_SLOT", "slotIndex must be between 1 and 12.")
        }
        return try encodeRequest(method: "peripheral/switchFocus", params: ["slotIndex": slotIndex])
    }

    func buildSetBrainpowerRequest(direction: String, slotIndex: Int? = nil) throws -> String {
        guard ["stepUp", "stepDown"].contains(direction) else {
            throw failure("INVALID_DIRECTION", "direction must be stepUp or stepDown.")
        }
        return try encodeRequest(method: "peripheral/setBrainpower", params: [
            "slotIndex": slotIndex ?? focusedSlot,
            "direction": direction
        ])
    }

    func buildSelectOptionRequest(action: String, optionIndex: Int? = nil, slotIndex: Int? = nil) throws -> String {
        guard ["ACCEPT", "REJECT", "ALWAYS_ALLOW"].contains(action) else {
            throw failure("INVALID_OPTION_ACTION", "action must be ACCEPT, REJECT, or ALWAYS_ALLOW.")
        }
        let targetSlot = slotIndex ?? focusedSlot
        var resolvedIndex = optionIndex ?? 0
        if optionIndex == nil, let options = slotsByIndex[targetSlot]?.question?.options,
           let idx = options.firstIndex(of: action) {
            resolvedIndex = idx
        }
        return try encodeRequest(method: "peripheral/selectOption", params: [
            "slotIndex": targetSlot,
            "optionIndex": resolvedIndex,
            "action": action
        ])
    }

    /// macOS Carbon/CGEvent virtual keyCodes for F1..F12 and their factory Mac media key counterparts
    static let macFKeyCodesToSlot: [Int: Int] = [
        122: 1, 105: 1, // F1 / Brightness Down
        120: 2, 106: 2, // F2 / Brightness Up
        99:  3, 160: 3, // F3 / Mission Control
        118: 4, 131: 4, 177: 4, // F4 / Spotlight / Launchpad
        96:  5,         // F5 / Dictation
        97:  6,         // F6 / Focus
        98:  7, 172: 7, // F7 / Previous Track
        100: 8, 174: 8, // F8 / Play-Pause
        101: 9, 171: 9, // F9 / Next Track
        109: 10, 168: 10, // F10 / Mute
        103: 11, 170: 11, // F11 / Volume Down
        111: 12, 169: 12  // F12 / Volume Up
    ]

    func buildAbortRequest(slotIndex: Int? = nil) throws -> String {
        return try encodeRequest(method: "peripheral/abort", params: [
            "slotIndex": slotIndex ?? focusedSlot
        ])
    }

    func buildTransportChangedNotification(
        transport: String,
        model: String? = nil,
        vendorId: Int? = nil,
        productId: Int? = nil,
        rgb: Bool,
        keys: Bool,
        ledBlink: Bool,
        wireless: Bool
    ) throws -> String {
        let normalized = transport.lowercased()
        guard ["usb", "2.4g", "bluetooth", "disconnected"].contains(normalized) else {
            throw failure("INVALID_TRANSPORT", "transport must be usb, 2.4g, bluetooth, or disconnected.")
        }
        var params: [String: Any] = [
            "transport": normalized,
            "capabilities": [
                "rgb": rgb,
                "keys": keys,
                "ledBlink": ledBlink,
                "wireless": wireless
            ]
        ]
        if let model = model { params["model"] = model }
        if let vendorId = vendorId { params["vendorId"] = vendorId }
        if let productId = productId { params["productId"] = productId }
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "peripheral/transportChanged",
            "params": params
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    /// Maps a physical macOS virtual keyCode to a JSON-RPC 2.0 request according to the focused slot state.
    func handlePhysicalKeyCode(_ keyCode: Int) throws -> String? {
        // 1. F1..F12 always switches focus to the corresponding slot (1..12)
        if let targetSlot = Self.macFKeyCodesToSlot[keyCode] {
            return try buildSwitchFocusRequest(slotIndex: targetSlot)
        }
        // 2. When the focused slot is in NEEDS_INPUT, decision keys resolve the approval/question
        if let current = slotsByIndex[focusedSlot], current.status == .needsInput {
            switch keyCode {
            case 36, 16, 18: // Return (36), Y (16), 1 (18) -> ACCEPT
                return try buildSelectOptionRequest(action: "ACCEPT", optionIndex: 0)
            case 53, 45, 19: // Escape (53), N (45), 2 (19) -> REJECT
                return try buildSelectOptionRequest(action: "REJECT", optionIndex: 1)
            case 20: // 3 (20) -> ALWAYS_ALLOW
                return try buildSelectOptionRequest(action: "ALWAYS_ALLOW", optionIndex: 2)
            default:
                break
            }
        }
        return nil
    }

    private func encodeRequest(method: String, params: [String: Any]) throws -> String {
        let id = nextRequestId
        nextRequestId += 1
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    func renderFrame(nowMs: Double = ProcessInfo.processInfo.systemUptime * 1000.0, brightness: Double = 1.0, pulseFocused: Bool = true) -> [UInt8] {
        let elapsed = max(0.0, nowMs - focusSelectedAtMs)
        return DshFrameRenderer.composeFrame(
            slots: orderedSlots,
            focusedSlot: focusedSlot,
            elapsedMs: elapsed,
            brightness: brightness,
            pulseFocused: pulseFocused
        )
    }

    func syncToDevice(_ device: Air75Device, nowMs: Double = ProcessInfo.processInfo.systemUptime * 1000.0, updateSide: Bool = false, verify: Bool = false, pulseFocused: Bool = true) throws -> [String: Any] {
        if !device.connected {
            _ = try device.connect()
        }
        if !device.armed {
            _ = try device.arm()
        }
        let frame = renderFrame(nowMs: nowMs, pulseFocused: pulseFocused)
        let paintResult = try device.paint(frame, verify: verify)
        if updateSide {
            let side = DshFrameRenderer.sideBarTarget(slots: orderedSlots, focusedSlot: focusedSlot)
            _ = try device.setSide(color: side.color, brightness: side.brightness)
        }
        return paintResult
    }
}

final class DshWebSocketDaemon: @unchecked Sendable {
    let url: URL
    let server: JSONServer
    let rpcSession = DshJsonRpcSession()
    private let urlSession = URLSession(configuration: .default)
    private var wsTask: URLSessionWebSocketTask?
    private var frameTimer: DispatchSourceTimer?
    private var reconnectWorkItem: DispatchWorkItem?
    private var keyTap: CFMachPort?
    private var keyTapSource: CFRunLoopSource?
    private var permissionRetryTimer: DispatchSourceTimer?
    private var lastAdaptedSlots = [Int]()
    private var lastReportedTransport = ""
    private var btLedIlluminated = false
    private var currentDelayMs: Double = 500.0
    private let initialDelayMs: Double = 500.0
    private let maxDelayMs: Double = 5000.0
    private let backoffMultiplier: Double = 1.5
    private var running = false

    private static let macMediaKeySources: [Int: UInt64] = [
        105:   0x700000069, // Brightness Down (Mac factory F1)
        106:   0x70000006a, // Brightness Up (Mac factory F2)
        32262: 0xc0000029f, // Mission Control (Mac factory F3)
        32264: 0xc000000cf, // Dictation / Voice Command (Mac factory F5)
        32278: 0x10000009b, // Do Not Disturb (Mac factory F6)
        172:   0xc000000b6, // Previous Track (Mac factory F7)
        174:   0xc000000cd, // Play/Pause (Mac factory F8)
        171:   0xc000000b5, // Next Track (Mac factory F9)
        168:   0xc000000e2, // Mute (Mac factory F10)
        170:   0xc000000ea, // Volume Down (Mac factory F11)
        169:   0xc000000e9  // Volume Up (Mac factory F12)
    ]

    private var hardwareMockMode: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["DSH_HID_MOCK"] == "1" || env["VITEST"] == "true"
    }

    init(url: URL, server: JSONServer) {
        self.url = url
        self.server = server
    }

    func start() {
        guard !running else { return }
        running = true
        if !hardwareMockMode && server.device.recoveryPending {
            _ = try? server.device.restore()
        }
        emit(["event": "dshDaemonStarted", "url": url.absoluteString])
        if !hardwareMockMode {
            startGlobalKeyTapIfPermitted()
            startPermissionCheckLoop()
        }
        connectWebSocket()
        startFrameLoop()
    }

    func stop() {
        running = false
        if btLedIlluminated {
            btLedIlluminated = false
            BluetoothKeyboard.setCapsLockLED(on: false)
        }
        stopGlobalKeyTap()
        permissionRetryTimer?.cancel()
        permissionRetryTimer = nil
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        frameTimer?.cancel()
        frameTimer = nil
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
    }

    private func connectWebSocket() {
        guard running else { return }
        let task = urlSession.webSocketTask(with: url)
        self.wsTask = task
        task.resume()
        receiveNext(task: task)
    }

    private func receiveNext(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            DispatchQueue.main.async {
                guard self.running, self.wsTask === task else { return }
                switch result {
                case .success(let message):
                    self.currentDelayMs = self.initialDelayMs
                    let text: String?
                    switch message {
                    case .string(let s): text = s
                    case .data(let d): text = String(data: d, encoding: .utf8)
                    @unknown default: text = nil
                    }
                    if let text = text {
                        self.handleIncomingText(text)
                    }
                    self.receiveNext(task: task)
                case .failure(let error):
                    diagnostic("WebSocket disconnected (\(error.localizedDescription)); scheduling reconnect...")
                    self.wsTask = nil
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        guard running, reconnectWorkItem == nil else { return }
        let delaySeconds = currentDelayMs / 1000.0
        currentDelayMs = min(currentDelayMs * backoffMultiplier, maxDelayMs)
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.reconnectWorkItem = nil
            self.connectWebSocket()
        }
        reconnectWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds, execute: item)
    }

    private func handleIncomingText(_ text: String) {
        do {
            let nowMs = ProcessInfo.processInfo.systemUptime * 1000.0
            let action = try rpcSession.handleIncomingJson(text, nowMs: nowMs)
            switch action {
            case .renderRequired(let sideChanged):
                let activeCount = rpcSession.slotsByIndex.values.filter { $0.status != .inactive }.count
                emit([
                    "event": "dshStateSynced",
                    "focusedSlot": rpcSession.focusedSlot,
                    "activeSlotCount": activeCount,
                    "sideChanged": sideChanged
                ])
                renderToHardwareIfAvailable(nowMs: nowMs, updateSide: sideChanged)
            case .serverShuttingDown:
                emit(["event": "dshServerShuttingDown"])
                if server.device.connected && server.device.recoveryPending {
                    _ = try? server.device.restore()
                }
                server.shutdown()
            case .rpcResponse(let id, let ok):
                emit(["event": "dshRpcResponse", "id": id, "ok": ok])
            case .none:
                break
            }
        } catch {
            diagnostic("DSH JSON-RPC message error: \(error)")
        }
    }

    private var lastDeviceProbeAtMs: Double = 0

    private func startFrameLoop() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 0.033, repeating: 0.033) // ~30 FPS delta-diff loop for breathing states
        timer.setEventHandler { [weak self] in
            guard let self = self,
                  self.running,
                  !self.hardwareMockMode else { return }
            let nowMs = ProcessInfo.processInfo.systemUptime * 1000.0

            // Background device probe & reconnect every 1.5s if not currently connected
            if !self.server.device.connected && nowMs - self.lastDeviceProbeAtMs >= 1500.0 {
                self.lastDeviceProbeAtMs = nowMs
                self.renderToHardwareIfAvailable(nowMs: nowMs, updateSide: false)
            }

            if self.server.device.connected && self.server.device.armed {
                guard self.rpcSession.hasActiveSlots, self.rpcSession.shouldPulseFocusedSlot else { return }
                _ = try? self.rpcSession.syncToDevice(self.server.device, nowMs: nowMs, updateSide: false, verify: false, pulseFocused: true)
            } else if self.lastReportedTransport == "bluetooth" {
                self.syncBluetoothFallbackLED(nowMs: nowMs)
            }
        }
        timer.resume()
        self.frameTimer = timer
    }

    private func syncBluetoothFallbackLED(nowMs: Double) {
        let focusedStatus = rpcSession.slotsByIndex[rpcSession.focusedSlot]?.status ?? .inactive
        let elapsedMs = max(0.0, nowMs - rpcSession.focusSelectedAtMs)
        let shouldIlluminate = BluetoothKeyboard.shouldIlluminateCapsLockLED(status: focusedStatus, elapsedMs: elapsedMs)
        if shouldIlluminate != btLedIlluminated {
            btLedIlluminated = shouldIlluminate
            BluetoothKeyboard.setCapsLockLED(on: shouldIlluminate)
        }
    }

    private func reportTransportIfChanged(
        mode: String,
        model: String?,
        vendorId: Int?,
        productId: Int?,
        rgb: Bool,
        keys: Bool,
        ledBlink: Bool,
        wireless: Bool
    ) {
        guard mode != lastReportedTransport else { return }
        if lastReportedTransport == "bluetooth" && mode != "bluetooth" && btLedIlluminated {
            btLedIlluminated = false
            BluetoothKeyboard.setCapsLockLED(on: false)
        }
        lastReportedTransport = mode
        if let json = try? rpcSession.buildTransportChangedNotification(
            transport: mode,
            model: model,
            vendorId: vendorId,
            productId: productId,
            rgb: rgb,
            keys: keys,
            ledBlink: ledBlink,
            wireless: wireless
        ) {
            sendRpcRequest(json)
        }
    }

    private func renderToHardwareIfAvailable(nowMs: Double, updateSide: Bool) {
        guard !hardwareMockMode else { return }
        do {
            if !server.device.connected {
                _ = try server.device.connect()
            }
            if !rpcSession.hasActiveSlots {
                syncActiveFunctionKeys()
                if server.device.armed && server.device.recoveryPending {
                    _ = try? server.device.restore()
                }
                reportTransportIfChanged(
                    mode: server.device.transportMode.lowercased(),
                    model: server.device.modelName,
                    vendorId: 0x19f5,
                    productId: server.device.productId,
                    rgb: true,
                    keys: true,
                    ledBlink: false,
                    wireless: server.device.isDongle
                )
                return
            }
            _ = try rpcSession.syncToDevice(
                server.device,
                nowMs: nowMs,
                updateSide: updateSide,
                verify: false,
                pulseFocused: rpcSession.shouldPulseFocusedSlot
            )
            reportTransportIfChanged(
                mode: server.device.transportMode.lowercased(),
                model: server.device.modelName,
                vendorId: 0x19f5,
                productId: server.device.productId,
                rgb: true,
                keys: true,
                ledBlink: false,
                wireless: server.device.isDongle
            )
            syncActiveFunctionKeys()
        } catch let error as BridgeError where ["DEVICE_NOT_FOUND", "HID_TIMEOUT", "INVALID_REPLY", "IOKIT_READ_TIMEOUT", "DISCONNECTED", "NOT_CONNECTED"].contains(error.code) {
            // Hardware not currently reachable over USB or 2.4G dongle; check Bluetooth fallback.
            if !BluetoothKeyboard.identities().isEmpty {
                reportTransportIfChanged(
                    mode: "bluetooth",
                    model: "Air75 V3",
                    vendorId: 2007,
                    productId: 0,
                    rgb: false,
                    keys: true,
                    ledBlink: true,
                    wireless: true
                )
                syncBluetoothFallbackLED(nowMs: nowMs)
            } else {
                let isDonglePresent = server.device.isDongle
                reportTransportIfChanged(
                    mode: "disconnected",
                    model: isDonglePresent ? "Air75 V3 Dongle" : nil,
                    vendorId: isDonglePresent ? 0x19f5 : nil,
                    productId: isDonglePresent ? server.device.productId : nil,
                    rgb: false,
                    keys: false,
                    ledBlink: false,
                    wireless: isDonglePresent
                )
            }
        } catch {
            diagnostic("Hardware sync warning: \(error)")
        }
    }

    private func syncActiveFunctionKeys() {
        guard server.device.connected else { return }
        let activeSlots = (1...12).filter { (rpcSession.slotsByIndex[$0]?.status ?? .inactive) != .inactive }
        guard activeSlots != lastAdaptedSlots else { return }

        if activeSlots.isEmpty {
            _ = try? server.adaptation.restore()
            if server.device.hasFunctionKeyBackup {
                _ = try? server.device.restoreFunctionKey()
            }
            lastAdaptedSlots = []
            return
        }

        do {
            var map = try server.device.readKeymap()
            if activeSlots.contains(4) {
                if let mode = map["mode"] as? Int, mode == 0,
                   let defaults = map["defaults"] as? [[Int]], defaults.count == 2,
                   let f4Pos = defaults[1].firstIndex(of: 61),
                   let active = map["active"] as? [Int], f4Pos < active.count,
                   active[f4Pos] == 32263 {
                    _ = try? server.device.prepareFunctionKey()
                    map = try server.device.readKeymap()
                }
            } else if server.device.hasFunctionKeyBackup {
                _ = try? server.device.restoreFunctionKey()
                map = try server.device.readKeymap()
            }

            guard let defaults = map["defaults"] as? [[Int]], defaults.count == 2,
                  let active = map["active"] as? [Int], active.count == 98,
                  let locationId = map["locationId"] as? Int, locationId > 0 else {
                return
            }

            let winFactory = defaults[1]
            var mappings = [[String: UInt64]]()
            for slotIndex in activeSlots {
                let target = 57 + slotIndex // 58 (F1) .. 69 (F12)
                guard let pos = winFactory.firstIndex(of: target),
                      winFactory.lastIndex(of: target) == pos,
                      pos < 96 else { continue }
                let source = active[pos]
                if source == target { continue }
                let usage: UInt64?
                if source == target + 46 {
                    usage = 0x700000000 + UInt64(source)
                } else {
                    usage = Self.macMediaKeySources[source]
                }
                guard let srcUsage = usage,
                      !mappings.contains(where: { $0["HIDKeyboardModifierMappingSrc"] == srcUsage }) else {
                    continue
                }
                mappings.append([
                    "HIDKeyboardModifierMappingSrc": srcUsage,
                    "HIDKeyboardModifierMappingDst": 0x700000000 + UInt64(target)
                ])
            }

            _ = try server.adaptation.apply([
                "locationId": UInt64(locationId),
                "mappings": mappings
            ], requireInputMonitoring: false)
            lastAdaptedSlots = activeSlots
        } catch {
            diagnostic("Function key adaptation warning: \(error)")
        }
    }

    private func startPermissionCheckLoop() {
        guard permissionRetryTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2.0, repeating: 2.0)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.running, !self.hardwareMockMode else { return }
            if self.keyTap == nil {
                self.startGlobalKeyTapIfPermitted()
            }
        }
        timer.resume()
        self.permissionRetryTimer = timer
    }

    private func startGlobalKeyTapIfPermitted() {
        guard keyTap == nil else { return }
        if !CGPreflightListenEventAccess() {
            _ = CGRequestListenEventAccess()
        }
        let promptOptions: NSDictionary = ["AXTrustedCheckOptionPrompt": true]
        _ = AXIsProcessTrustedWithOptions(promptOptions as CFDictionary)

        let context = Unmanaged.passUnretained(self).toOpaque()
        let mask = CGEventMask(1) << CGEventType.keyDown.rawValue
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, context in
                if let context = context {
                    Unmanaged<DshWebSocketDaemon>.fromOpaque(context).takeUnretainedValue().handleGlobalKeyEvent(type, event)
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: context
        ) else {
            return
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return
        }
        keyTap = tap
        keyTapSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        diagnostic("Global key tap installed successfully.")
    }

    private func stopGlobalKeyTap() {
        if let tap = keyTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source = keyTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        keyTap = nil
        keyTapSource = nil
    }

    private func handleGlobalKeyEvent(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = keyTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        guard type == .keyDown,
              event.getIntegerValueField(.keyboardEventAutorepeat) == 0,
              event.flags.intersection(KeyHooks.modifierMask).isEmpty else {
            return
        }
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        if let json = try? rpcSession.handlePhysicalKeyCode(code) {
            sendRpcRequest(json)
        }
    }

    func sendRpcRequest(_ jsonString: String) {
        guard let task = wsTask else { return }
        task.send(.string(jsonString)) { error in
            if let error = error {
                diagnostic("Failed to send JSON-RPC request: \(error.localizedDescription)")
            }
        }
    }
}

final class JSONServer {
    let device: Air75Device
    let adaptation: KeyAdaptation
    let keys = KeyHooks()
    let trigger = TriggerHooks()
    let bluetooth = BluetoothKeyboard()
    weak var wsDaemon: DshWebSocketDaemon?
    private var pending = [[String: Any]]()
    private var processing = false
    private var stopping = false
    private var inputEnded = false
    private var finishing = false
    init(device: Air75Device) {
        self.device = device
        adaptation = KeyAdaptation(journal:device.backupURL.deletingLastPathComponent().appendingPathComponent("key-mapping-backup.json"))
        do { _ = try adaptation.restore() } catch { diagnostic("Pending key restore: \(error)") }
    }
    func enqueue(_ command: [String: Any]) {
        if stopping { return }
        // Bound the queue rather than letting an animation create minutes of lag.
        if pending.count >= 8 {
            emit(["id": command["id"] ?? NSNull(), "ok": false,
                  "error": failure("BACKPRESSURE", "Wait for each paint response before sending the next frame.").json])
            return
        }
        pending.append(command)
        drain()
    }
    private func drain() {
        guard !processing else { return }
        processing = true
        while !pending.isEmpty && !stopping {
            let command = pending.removeFirst()
            let id = command["id"] ?? NSNull()
            do { emit(["id": id, "ok": true, "result": try execute(command)]) }
            catch let error as BridgeError { emit(["id": id, "ok": false, "error": error.json]) }
            catch { emit(["id": id, "ok": false, "error": failure("INTERNAL_ERROR", error.localizedDescription).json]) }
        }
        processing = false
        if stopping || inputEnded { finishShutdown() }
    }
    private func execute(_ command: [String: Any]) throws -> [String: Any] {
        guard let op = command["op"] as? String else { throw failure("INVALID_REQUEST", "Every line must include op and an id.") }
        switch op {
        case "connect": return try device.connect()
        case "status": return try device.status()
        case "permissions": return permissionSnapshot()
        case "bluetoothDevices": return bluetooth.snapshot()
        case "openPermissionSettings": return try openPermissionSettings(command["permission"])
        case "arm": return try device.arm()
        case "paint": return try device.paint(parseColors(command["colors"], count: 84), verify: command["verify"] as? Bool ?? false)
        case "readColors": return ["colors": hexColors(try device.readRGB()), "ledCount": 104,
                                   "customColorScale": S4.stateLength(device.firmware) == 22 ? 200 : 255]
        case "readKeymap": return try device.readKeymap()
        case "prepareFunctionKey": return try device.prepareFunctionKey()
        case "restoreFunctionKey": return try device.restoreFunctionKey()
        case "adaptKeys": return try adaptation.apply(command)
        case "keyMappingStatus": return try adaptation.status(command)
        case "restoreKeys": return try adaptation.restore()
        case "systemIdle":
            let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
            return ["idleMs": seconds.isFinite && seconds >= 0 ? seconds * 1000 : NSNull(), "recordsKeys": false]
        case "side":
            if command["restore"] as? Bool == true { return try device.restoreSide() }
            guard let color = command["color"] as? String else { throw failure("INVALID_SIDE", "side requires a color string.") }
            return try device.setSide(color: parseColor(color), brightness: command["brightness"] as? Int ?? 60)
        case "restore": return try device.restore()
        case "disconnect":
            var keyErrors = [String]()
            do { _ = try adaptation.restore() } catch { keyErrors.append(String(describing: error)) }
            do { _ = try device.restoreFunctionKey() } catch { keyErrors.append(String(describing: error)) }
            var result = try device.disconnect()
            if !keyErrors.isEmpty { result["keyRestoreErrors"] = keyErrors }
            return result
        case "keyMonitor": return try keys.configure(command)
        case "triggerMonitor": return try trigger.configure(command)
        case "shortcut": return try keys.shortcut(command)
        case "dshRender":
            let rawSlots = command["slots"] as? [[String: Any]] ?? []
            let slots = try rawSlots.map { try DshSlotInfo.fromDictionary($0) }
            let focusedSlot = command["focusedSlot"] as? Int ?? 1
            let elapsedMs = (command["elapsedMs"] as? NSNumber)?.doubleValue ?? 0.0
            let brightness = (command["brightness"] as? NSNumber)?.doubleValue ?? 1.0
            let pulseFocused = command["pulseFocused"] as? Bool ?? true
            let verify = command["verify"] as? Bool ?? false
            let frame = DshFrameRenderer.composeFrame(
                slots: slots,
                focusedSlot: focusedSlot,
                elapsedMs: elapsedMs,
                brightness: brightness,
                pulseFocused: pulseFocused
            )
            if command["dryRun"] as? Bool == true {
                return ["colors": hexColors(frame), "ledCount": 84]
            }
            return try device.paint(frame, verify: verify)
        case "dshState":
            guard let daemon = wsDaemon else { throw failure("NO_WS_DAEMON", "WebSocket daemon is not enabled.") }
            let frame = daemon.rpcSession.renderFrame(pulseFocused: false)
            return [
                "focusedSlot": daemon.rpcSession.focusedSlot,
                "activeSlotCount": daemon.rpcSession.slotsByIndex.values.filter { $0.status != .inactive }.count,
                "colors": hexColors(frame)
            ]
        case "dshSendRpc":
            guard let daemon = wsDaemon else { throw failure("NO_WS_DAEMON", "WebSocket daemon is not enabled.") }
            guard let rpcType = command["rpc"] as? String else { throw failure("INVALID_RPC", "dshSendRpc requires rpc type.") }
            let jsonString: String
            switch rpcType {
            case "switchFocus":
                let slot = command["slotIndex"] as? Int ?? 1
                jsonString = try daemon.rpcSession.buildSwitchFocusRequest(slotIndex: slot)
            case "setBrainpower":
                let dir = command["direction"] as? String ?? "stepUp"
                let slot = command["slotIndex"] as? Int
                jsonString = try daemon.rpcSession.buildSetBrainpowerRequest(direction: dir, slotIndex: slot)
            case "selectOption":
                let action = command["action"] as? String ?? "ACCEPT"
                let optIdx = command["optionIndex"] as? Int
                let slot = command["slotIndex"] as? Int
                jsonString = try daemon.rpcSession.buildSelectOptionRequest(action: action, optionIndex: optIdx, slotIndex: slot)
            case "abort":
                let slot = command["slotIndex"] as? Int
                jsonString = try daemon.rpcSession.buildAbortRequest(slotIndex: slot)
            case "transportChanged":
                let transport = command["transport"] as? String ?? "2.4g"
                let model = command["model"] as? String
                let vendorId = command["vendorId"] as? Int
                let productId = command["productId"] as? Int
                let isBt = transport.lowercased() == "bluetooth"
                let isDisconnected = transport.lowercased() == "disconnected"
                jsonString = try daemon.rpcSession.buildTransportChangedNotification(
                    transport: transport,
                    model: model,
                    vendorId: vendorId,
                    productId: productId,
                    rgb: !isBt && !isDisconnected,
                    keys: !isDisconnected,
                    ledBlink: isBt,
                    wireless: transport.lowercased() != "usb" && !isDisconnected
                )
            default:
                throw failure("UNKNOWN_RPC", "Unknown dshSendRpc type: \(rpcType)")
            }
            daemon.sendRpcRequest(jsonString)
            return ["sent": true, "jsonrpc": jsonString]
        case "dshKey":
            guard let daemon = wsDaemon else { throw failure("NO_WS_DAEMON", "WebSocket daemon is not enabled.") }
            guard let keyCode = command["keyCode"] as? Int else { throw failure("INVALID_KEYCODE", "dshKey requires an integer keyCode.") }
            if let jsonString = try daemon.rpcSession.handlePhysicalKeyCode(keyCode) {
                daemon.sendRpcRequest(jsonString)
                return ["handled": true, "keyCode": keyCode, "jsonrpc": jsonString]
            }
            return ["handled": false, "keyCode": keyCode]
        case "quit": wsDaemon?.stop(); stopping = true; return ["quitting": true]
        default: throw failure("UNKNOWN_OPERATION", "Unknown operation: \(op)")
        }
    }
    func shutdown() {
        stopping = true
        if !processing { finishShutdown() }
    }
    func finishInput() {
        inputEnded = true
        if !processing { drain() }
    }
    private func finishShutdown() {
        guard !finishing else { return }
        finishing = true
        keys.releaseShortcut()
        keys.stop()
        trigger.stop()
        var keysRestored = true
        var keysDeferred = false
        do { _ = try adaptation.restore(); keysDeferred = try device.restoreFunctionKey()["deferred"] as? Bool == true } catch {
            keysRestored = false
            diagnostic("Key restore failed: \(error)")
            emit(["event":"keyRestoreFailed", "error":String(describing:error)])
        }
        let lightingRestored = device.shutdown()
        emit(["event":"shutdownComplete", "lightingRestored":lightingRestored && !device.hasPendingBackups,
              "lightingDeferred":lightingRestored && device.hasPendingBackups, "keysRestored":keysRestored && !keysDeferred,"keysDeferred":keysDeferred])
        let restored = lightingRestored && keysRestored
        Darwin.exit(restored ? 0 : 2)
    }
}


func testBoardSleepLifecycle(_ check: (Bool, String) throws -> Void) throws {
    // Transaction doubles only. F3/F5 field ownership is independently proved
    // by the official binary offsets recorded in firmware-analysis.md.
    final class Board {
        var firmware: [UInt8] = [23,0,1,170,6,0,0,0]
        var serial = "self-test"
        var profile: UInt8 = 0
        var sleep: [UInt8] = [1,6,30,97]
        var state: [UInt8] = [6,60,2,0,1,0,255,255,255,2,0,0,0,0,0,0,0,0,0,0,0,0]
        var frames = [[UInt8]]()
        var writes = [UInt8]()
        var reads = 0
        var onWrite: ((UInt8) throws -> Void)?
        var beforeRead: ((Int) -> Void)?
        var failBeforeWrite = false
        var failAfterWrite = false
        var failRestore = false
        var wrongAck = false
        var ignoreSleepWrite = false
        var changeTimeAfterWrite = false
        var failNextD6 = false
        func exchange(_ frame: [UInt8]) throws -> [UInt8] {
            frames.append(frame)
            let command = frame[1], length = Int(frame[4]), address = Int(frame[5]) | Int(frame[6]) << 8
            var payload: [UInt8]
            switch command {
            case 0xa1: payload = firmware
            case 0xa0: payload = [profile,8,4,6,firmware[2] == 4 ? 15 : 16,2,0,0]
            case 0xd1: payload = [firmware[2] == 4 ? 85 : 104]
            case 0xd5: payload = Array(state.prefix(length))
            case 0xd2: payload = Array(repeating:0,count:length)
            case 0xf3:
                reads += 1;beforeRead?(reads);payload = sleep
            case 0xf5:
                let enabled = frame[8]
                try onWrite?(enabled)
                if failBeforeWrite { failBeforeWrite = false;throw failure("SLEEP_TEST_WRITE","simulated rejected sleep write") }
                if enabled == 1 && failRestore { throw failure("SLEEP_TEST_RESTORE","simulated rejected sleep restoration") }
                if !ignoreSleepWrite { sleep[0] = enabled }
                writes.append(enabled)
                if changeTimeAfterWrite { sleep[1] &+= 1;changeTimeAfterWrite = false }
                if failAfterWrite { failAfterWrite = false;throw failure("SLEEP_TEST_ACK","simulated lost sleep ACK") }
                payload = [enabled]
                if wrongAck { payload = [enabled == 0 ? 1 : 0];wrongAck = false }
            case 0xd6:
                if failNextD6 { failNextD6 = false;throw failure("SLEEP_TEST_ARM","simulated failed RGB arm") }
                payload = Array(frame[8..<(8+length)])
                state.replaceSubrange(address..<(address+length),with:payload)
            case 0xd8: payload = Array(frame[8..<(8+length)])
            default: throw failure("SELF_TEST","unexpected board sleep fixture command")
            }
            var reply = [UInt8](repeating:0,count:64)
            reply[0] = 0xaa;reply[1] = command
            reply.replaceSubrange(4..<8,with:frame[4..<8])
            reply.replaceSubrange(8..<(8+payload.count),with:payload)
            reply[3] = S4.checksum(reply);return reply
        }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-sleep-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    defer { try? FileManager.default.removeItem(at:directory) }
    var sequence = 0
    func make(_ board: Board, model: USBKeyboardModel = .air75) throws -> Air75Device {
        sequence += 1
        let device = Air75Device(backupURL:directory.appendingPathComponent("case-\(sequence)/lighting-backup.json"),testModel:model,testSerial:{board.serial},testExchange:{try board.exchange($0)})
        _ = try device.connect();return device
    }
    func rejected(_ name: String, _ action: () throws -> Void) throws {
        do {try action();throw failure("SELF_TEST",name)}
        catch let error as BridgeError {try check(error.code != "SELF_TEST",name)}
    }
    let board = Board(), device = try make(board)
    try check(((try device.status())["capabilities"] as? [String:Any])?["boardSleepLease"] as? Bool == true,"qualified AIR advertises the exact inspected sleep lease")
    let original = board.sleep
    var durableBeforeMutation = false
    board.onWrite = { enabled in
        if enabled == 0 {
            let saved = try device.boardSleepJournal.read(serial:board.serial,firmware:board.firmware)
            durableBeforeMutation = saved.original == original
        }
    }
    let acquired = try device.acquireBoardSleepLease()
    try check(durableBeforeMutation && acquired["verified"] as? Bool == true && board.sleep == [0,6,30,97],"complete original sleep info is durable before the enable-only write")
    try check((acquired["boardSleepLease"] as? [String:Any])?["ownsChanges"] as? Bool == true && !device.recoveryPending,"sleep ownership is independent of an RGB journal")
    let savedBytes = try Data(contentsOf:device.boardSleepJournal.url), writes = board.writes.count
    let reads = board.reads
    _ = try device.acquireBoardSleepLease()
    try check(board.writes.count == writes && board.reads == reads + 1,"same-session acquisition is one lightweight read with no repeated F5")
    board.profile = 1;_ = try device.status();_ = try device.acquireBoardSleepLease()
    try check(try Data(contentsOf:device.boardSleepJournal.url) == savedBytes,"Mac/Win switch never replaces the board-global baseline")
    _ = try device.restore()
    try check(board.sleep == original && !device.boardSleepLeasePending && !device.recoveryPending,"ordinary restore releases a sleep-only lease without an RGB backup")
    try check(board.frames.filter{$0[1] == 0xf5}.allSatisfy{$0[4] == 1 && $0[5] == 0 && $0[6] == 0 && $0[7] == 0},"all F5 routes are global address-zero one-byte writes")

    let disabled = Board();disabled.sleep[0] = 0
    let off = try make(disabled), offResult = try off.acquireBoardSleepLease()
    try check(disabled.writes.isEmpty && !off.boardSleepLeasePending && (offResult["boardSleepLease"] as? [String:Any])?["ownsChanges"] as? Bool == false,"already-disabled board sleep needs no mutation or artificial pending original")

    let pendingBoard = Board(), pendingDevice = try make(pendingBoard)
    _ = try pendingDevice.acquireBoardSleepLease()
    let pendingOriginal = try Data(contentsOf:pendingDevice.boardSleepJournal.url)
    pendingDevice.didRemove()
    try check(pendingDevice.shutdown() && pendingBoard.writes == [0] && pendingDevice.boardSleepJournal.exists,"unplugged shutdown retains the original without reopening or sending F5")
    let offlineBase=pendingDevice.boardSleepJournal.url.deletingLastPathComponent().appendingPathComponent("lighting-backup.json")
    for attempt in 1...2 {
        var offlineExchangeCount=0
        let offline=Air75Device(backupURL:offlineBase,testSerial:{pendingBoard.serial},testExchange:{frame in
            offlineExchangeCount+=1;return try pendingBoard.exchange(frame)
        })
        try check(offline.shutdown(),"fresh offline launch \(attempt) defers a valid prior sleep original without a false quit error")
        try check(offlineExchangeCount==0 && (try Data(contentsOf:offline.boardSleepJournal.url))==pendingOriginal,
            "fresh offline quit \(attempt) neither opens a keyboard nor alters its original")
    }
    _ = try pendingDevice.connect();_ = try pendingDevice.acquireBoardSleepLease()
    try check(pendingBoard.writes == [0] && (try Data(contentsOf:pendingDevice.boardSleepJournal.url)) == pendingOriginal,"same-board reconnect resumes the original instead of capturing disabled zero")
    _ = try pendingDevice.releaseBoardSleepLease()
    try check(pendingBoard.sleep[0] == 1,"resumed sleep lease restores the actual original enable")

    let external = Board(), externalDevice = try make(external)
    _ = try externalDevice.acquireBoardSleepLease()
    let externalBytes = try Data(contentsOf:externalDevice.boardSleepJournal.url)
    external.sleep.replaceSubrange(1..<4,with:[9,44,173])
    let released = try externalDevice.releaseBoardSleepLease()
    let history = released["historyPath"] as? String ?? ""
    try check(external.sleep == [1,9,44,173] && released["preservedExternalChange"] as? Bool == true,"release restores only enable and retains all externally changed timing/reserved bytes")
    try check(!history.isEmpty && (try Data(contentsOf:URL(fileURLWithPath:history))) == externalBytes,"the exact old four-byte record is archived before externally changed times are retained")

    let otherFlag = Board(), otherFlagDevice = try make(otherFlag)
    _ = try otherFlagDevice.acquireBoardSleepLease();otherFlag.sleep[0] = 1
    try rejected("active external enable is never repeatedly disabled") {_ = try otherFlagDevice.acquireBoardSleepLease()}
    try check(otherFlag.writes == [0] && otherFlag.sleep[0] == 1 && !otherFlagDevice.boardSleepLeasePending,"external restoration of the original enable is accepted without another F5")
    let formerlyOff = Board(), formerlyOffDevice = try make(formerlyOff)
    try formerlyOffDevice.boardSleepJournal.save(BoardSleepBackup(createdAt:"prior",serial:formerlyOff.serial,firmware:formerlyOff.firmware,original:[0,6,30,97]))
    let preservedFlag = try formerlyOffDevice.releaseBoardSleepLease()
    try check(formerlyOff.writes.isEmpty && formerlyOff.sleep[0] == 1 && preservedFlag["preservedExternalChange"] as? Bool == true && preservedFlag["restored"] as? Bool == false,"external enable is never disabled when retiring a prior disabled baseline")
    let ignored = Board(), ignoredDevice = try make(ignored)
    ignored.ignoreSleepWrite = true
    try rejected("an echoed F5 without an applied setter cannot be accepted") {_ = try ignoredDevice.acquireBoardSleepLease()}
    try check(ignored.sleep[0] == 1 && ignored.writes == [0] && !ignoredDevice.boardSleepLeasePending,"F3 proves the setter instead of treating an ACK echo as success")
    let beforeRace = Board(), beforeRaceDevice = try make(beforeRace)
    beforeRace.beforeRead = { count in if count == 2 { beforeRace.sleep[1] = 8 } }
    try rejected("a timing change immediately before F5 aborts acquisition") {_ = try beforeRaceDevice.acquireBoardSleepLease()}
    try check(beforeRace.writes.isEmpty && beforeRace.sleep == [1,8,30,97],"prewrite timing races cannot cause even an enable write")

    for mode in ["before","after","ack","time"] {
        let failed = Board(), failedDevice = try make(failed)
        if mode == "before" {failed.failBeforeWrite = true}
        if mode == "after" {failed.failAfterWrite = true}
        if mode == "ack" {failed.wrongAck = true}
        if mode == "time" {failed.changeTimeAfterWrite = true}
        try rejected("\(mode) sleep failure is reported after scoped rollback") {_ = try failedDevice.acquireBoardSleepLease()}
        try check(failed.sleep[0] == 1 && !failedDevice.boardSleepLeasePending,"\(mode) failure restores enable before retiring its original")
        try check(Array(failed.sleep.dropFirst()) == (mode == "time" ? [7,30,97] : [6,30,97]),"\(mode) rollback never replays or changes unowned times")
    }
    let rollback = Board(), rollbackDevice = try make(rollback)
    rollback.failAfterWrite = true;rollback.failRestore = true
    try rejected("failed sleep rollback surfaces retained recovery") {_ = try rollbackDevice.acquireBoardSleepLease()}
    try check(rollbackDevice.boardSleepLeasePending && rollback.sleep[0] == 0,"failed sleep rollback keeps the sole durable original")
    rollback.failRestore = false;_ = try rollbackDevice.releaseBoardSleepLease()
    try check(rollback.sleep[0] == 1 && !rollbackDevice.boardSleepLeasePending,"failed sleep restoration can be retried from the unchanged original")

    for mismatch in ["serial","firmware","flag","short","json"] {
        let mismatched = Board(), mismatchedDevice = try make(mismatched)
        var saved = BoardSleepBackup(createdAt:"fixture",serial:mismatched.serial,firmware:mismatched.firmware,original:mismatched.sleep)
        if mismatch == "serial" {saved.serial = "different-board"}
        if mismatch == "firmware" {saved.firmware[0] = 22}
        if mismatch == "flag" {saved.original[0] = 2}
        if mismatch == "short" {saved.original = [1,6,30]}
        try mismatchedDevice.boardSleepJournal.save(saved)
        if mismatch == "json" {try Data("invalid original".utf8).write(to:mismatchedDevice.boardSleepJournal.url)}
        let exact = try Data(contentsOf:mismatchedDevice.boardSleepJournal.url)
        try rejected("\(mismatch) sleep original fails closed before F5") {_ = try mismatchedDevice.acquireBoardSleepLease()}
        try check(mismatched.writes.isEmpty && (try Data(contentsOf:mismatchedDevice.boardSleepJournal.url)) == exact,"\(mismatch) rejection preserves the exact original bytes")
    }
    for invalid in ["schema","emptySerial","firmware","flag","short","json"] {
        sequence+=1
        var exchanges=0
        let offline=Air75Device(backupURL:directory.appendingPathComponent("case-\(sequence)/lighting-backup.json"),testExchange:{_ in
            exchanges+=1;throw failure("SELF_TEST","offline validation must not open a device")
        })
        var saved=BoardSleepBackup(createdAt:"fixture",serial:"prior-board",firmware:[23,0,1,170,6,0,0,0],original:[1,6,24,4])
        if invalid=="schema" {saved.schema=2}
        if invalid=="emptySerial" {saved.serial=""}
        if invalid=="firmware" {saved.firmware[0]=22}
        if invalid=="flag" {saved.original[0]=2}
        if invalid=="short" {saved.original=[1]}
        try offline.boardSleepJournal.save(saved)
        if invalid=="json" {try Data("invalid original".utf8).write(to:offline.boardSleepJournal.url)}
        let bytes=try Data(contentsOf:offline.boardSleepJournal.url)
        try check(!offline.shutdown(),"offline \(invalid) original remains an actual recovery error")
        try check(exchanges==0 && (try Data(contentsOf:offline.boardSleepJournal.url))==bytes,
            "offline \(invalid) validation preserves exact bytes without hardware IO")
    }
    let changedBoard=Board(),changedDevice=try make(changedBoard)
    _ = try changedDevice.acquireBoardSleepLease();changedDevice.didRemove()
    var changedOriginal=try changedDevice.boardSleepJournal.readRetained();changedOriginal.original[1] &+= 1
    try JSONEncoder().encode(changedOriginal).write(to:changedDevice.boardSleepJournal.url)
    let changedBytes=try Data(contentsOf:changedDevice.boardSleepJournal.url)
    try check(!changedDevice.shutdown(),"owned offline original replacement remains a recovery error")
    try check(changedBoard.writes==[0] && (try Data(contentsOf:changedDevice.boardSleepJournal.url))==changedBytes,
        "owned offline mismatch neither writes nor deletes the replacement")
    let replacement = Board(), replacementDevice = try make(replacement)
    _ = try replacementDevice.acquireBoardSleepLease();replacementDevice.didRemove();replacement.serial = "replacement-board"
    _ = try replacementDevice.connect()
    try rejected("replacement serial cannot restore the old sleep original") {_ = try replacementDevice.releaseBoardSleepLease()}
    try check(replacement.writes == [0] && replacementDevice.boardSleepJournal.exists,"replacement connection sends no sleep restoration to a different board")

    for variant in ["unknown","kick","emptySerial"] {
        let unsupported = Board()
        if variant == "unknown" {unsupported.firmware[0] = 24}
        if variant == "kick" {unsupported.firmware = [18,0,4,170,6,0,0,0]}
        if variant == "emptySerial" {unsupported.serial = ""}
        let unsupportedDevice = try make(unsupported,model:variant == "kick" ? .kick75 : .air75)
        try rejected("\(variant) cannot acquire board sleep control") {_ = try unsupportedDevice.acquireBoardSleepLease()}
        try check(!unsupported.frames.contains{$0[1] == 0xf3 || $0[1] == 0xf5},"\(variant) sends neither new sleep read nor write")
    }
    let lost = Board(), lostDevice = try make(lost)
    _ = try lostDevice.acquireBoardSleepLease();try FileManager.default.removeItem(at:lostDevice.boardSleepJournal.url)
    try rejected("missing in-process original never captures disabled zero") {_ = try lostDevice.acquireBoardSleepLease()}
    try check(lost.writes == [0] && lostDevice.boardSleepLeasePending,"lost original remains an explicit unresolved ownership")

    let exitBoard = Board(), exitDevice = try make(exitBoard)
    _ = try exitDevice.acquireBoardSleepLease()
    try check(exitDevice.shutdown() && exitBoard.sleep[0] == 1 && !exitDevice.boardSleepLeasePending,"sleep-only native shutdown releases without requiring lighting mutation")
    let disconnectBoard = Board(), disconnectDevice = try make(disconnectBoard)
    _ = try disconnectDevice.acquireBoardSleepLease();_ = try disconnectDevice.disconnect()
    try check(disconnectBoard.sleep[0] == 1 && !disconnectDevice.boardSleepLeasePending,"disconnect releases board sleep before closing its USB handle")
    let armBoard = Board(), armDevice = try make(armBoard)
    _ = try armDevice.acquireBoardSleepLease();armBoard.failNextD6 = true
    try rejected("RGB arm failure still reports failure") {_ = try armDevice.arm()}
    try check(armBoard.sleep[0] == 1 && !armDevice.boardSleepLeasePending,"native RGB rollback also releases its independent sleep lease")
    for wake in [false,true] {
        let preflight = Board(), preflightDevice = try make(preflight)
        _ = try preflightDevice.acquireBoardSleepLease()
        let invalid = Data("preserved invalid RGB original".utf8)
        try invalid.write(to:preflightDevice.backupURL)
        try rejected("\(wake) RGB preflight failure is reported") {
            if wake {_ = try preflightDevice.armConnectionWake()} else {_ = try preflightDevice.arm()}
        }
        try check(preflight.sleep[0] == 1 && !preflightDevice.boardSleepLeasePending && (try Data(contentsOf:preflightDevice.backupURL)) == invalid,"\(wake) RGB preflight failure releases sleep and retains the unrelated RGB original")
        try check(!preflight.frames.contains{$0[1] == 0xd6 || $0[1] == 0xd8},"\(wake) rejected RGB preflight never adds a lighting write")
    }

    for (command,length,address,payload,handle) in [(UInt8(0xf3),1,0,[UInt8](),UInt8(0)),(0xf3,4,0,[],1),(0xf5,4,0,[0,6,30,0],0),(0xf5,1,1,[0],0),(0xf5,1,0,[2],0),(0xf5,1,0,[0],1)] {
        try rejected("sleep envelope rejects unowned fields and profile routes") {_ = try S4.frame(command:command,length:length,address:address,payload:payload,handle:handle,key:0)}
    }
}
func testKickLifecycle(_ check: (Bool,String) throws -> Void) throws {
    final class Board {
        var state: [UInt8] = [6,50,2,0,1,0,0,5,128,0,60,2,0,0,255,0,0]
        var colors = (0..<255).map { UInt8($0 % 127) }
        var columns: UInt8 = 15
        var version: UInt8 = 15
        var profile: UInt8 = 0
        var writes = 0
        var indices = [UInt8]()
        func exchange(_ frame: [UInt8]) throws -> [UInt8] {
            let command = frame[1], length = Int(frame[4]), address = Int(frame[5]) | Int(frame[6]) << 8
            var payload: [UInt8]
            switch command {
            case 0xa1: payload = [version,0,4,170,6,0,0,0]
            case 0xa0: payload = [profile,8,4,6,columns,130,0,0]
            case 0xd1: payload = [85]
            case 0xd5: payload = state
            case 0xd2: payload = Array(colors[address..<(address+length)])
            case 0xd6:
                writes += 1; payload = Array(frame[8..<(8+length)])
                state.replaceSubrange(address..<(address+length),with:payload)
            case 0xd8:
                guard version == 18 else { throw failure("SELF_TEST","D8 sent to old Kick firmware") }
                writes += 1; payload = Array(frame[8..<(8+length)])
                for offset in stride(from: 0,to: length,by: 4) {
                    let index = payload[offset]
                    guard index < 80 else { throw failure("SELF_TEST","Kick write addressed a side/nonexistent key") }
                    indices.append(index)
                    colors.replaceSubrange(Int(index)*3..<(Int(index)*3+3),with:payload[(offset+1)..<(offset+4)])
                }
            default: throw failure("SELF_TEST","Unexpected Kick transaction")
            }
            guard payload.count == length else { throw failure("SELF_TEST","Kick response size mismatch") }
            var reply = [UInt8](repeating:0,count:64)
            reply[0] = 0xaa; reply[1] = command
            reply.replaceSubrange(4..<8,with:frame[4..<8]); reply.replaceSubrange(8..<(8+length),with:payload)
            reply[3] = S4.checksum(reply); return reply
        }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-kick-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    defer { try? FileManager.default.removeItem(at:directory) }
    let base = directory.appendingPathComponent("original.json")
    let oldAirBytes = Data("existing AIR restoration remains untouched".utf8)
    try oldAirBytes.write(to:base)
    let board = Board(), originalState = Board().state, originalColors = Board().colors
    let device = Air75Device(backupURL:base,testModel:.kick75,testExchange:{try board.exchange($0)})
    let identification = try device.connect()
    try check(identification["modelId"] as? String == "kick75" && device.ledCount == 85,"Kick USB profile selects 80+5 LEDs")
    try check(device.journals.legacyURL != base && !device.recoveryPending,"Kick never picks up a pending AIR record")
    do { _ = try device.arm(); throw failure("SELF_TEST","old Kick firmware entered unsupported custom mode") }
    catch let e as BridgeError { try check(e.code == "PER_KEY_UNSUPPORTED" && board.writes == 0 && !device.recoveryPending,"old Kick rejects per-key requests before backup or write") }
    _ = try device.nativeLighting(["mode":3,"brightness":1,"color":"#400000"])
    let kickRecord = try device.journals.read(device.backupURL,serial:"self-test")
    try check(kickRecord.productID == 0x1026 && kickRecord.renderedColors.count == 255,"Kick native effects retain a durable model-specific original")
    do {
        _ = try LightingJournals(legacyURL:base).read(device.backupURL,serial:"self-test")
        throw failure("SELF_TEST","AIR journal reader accepted a Kick record")
    } catch let e as BridgeError { try check(e.code == "INVALID_BACKUP","cross-model restoration record rejected") }
    try check(Array(board.state.suffix(8)) == Array(originalState.suffix(8)) && board.indices.isEmpty,"Kick main effect preserves every side field and sends no D8")
    _ = try device.restore()
    try check(board.state == originalState && board.colors == originalColors && !device.recoveryPending,"Kick native effect restores every saved field")
    try check(try Data(contentsOf:base) == oldAirBytes,"AIR journal survives Kick connect/play/restore byte for byte")
    board.columns = 16; let priorWrites = board.writes
    let unsupported=try device.connect()
    try check(unsupported["identified"] as? Bool == true && unsupported["readOnly"] as? Bool == true && unsupported["errorCode"] as? String == "UNSUPPORTED_PROTOCOL" && board.writes == priorWrites,"cross-model geometry retains identity but fails before mutation")
    try check(USBKeyboardModel.identify(vendor:0x19f5,product:0x1027) == .kick75 && USBKeyboardModel.identify(vendor:0x19f5,product:0x1028) == .air75,"production and legacy Kick USB IDs stay distinct from AIR")
    try check(S4.renderedCustomColors([255,128,64],firmware:[15,0,4,170,6,0,0,0],model:.kick75) == [255,128,64],"Kick does not inherit AIR quantization or the last-LED colour special case")
    _ = try device.disconnect()
    let latest = Board(); latest.version = 18
    let upgraded = Air75Device(backupURL:base,testModel:.kick75,testExchange:{try latest.exchange($0)})
    let identified = try upgraded.connect()
    try check((identified["capabilities"] as? [String:Any])?["perKey"] as? Bool == true,"qualified Kick 4.0.18.6 exposes its D8 capability")
    try check((identified["capabilities"] as? [String:Any])?["connectionWake"] as? Bool == true,"qualified Kick exposes connection wake")
    try check((identified["capabilities"] as? [String:Any])?["boardSleepLease"] as? Bool == false,"Kick does not inherit AIR sleep writes")
    _ = try upgraded.armConnectionWake()
    try check(latest.colors.prefix(240).allSatisfy{$0 == 0},"Kick wake starts with a verified black main palette")
    _ = try upgraded.restore()
    try check(latest.state == originalState && latest.colors == originalColors && !upgraded.recoveryPending,"Kick wake restores its exact original state and palette")
    _ = try upgraded.arm()
    let captured = try upgraded.journals.read(upgraded.backupURL,serial:"self-test")
    try check(captured.customColors == Array(originalColors.prefix(240)),"new Kick captures its global original palette before any D8 write")
    let paint = (0..<252).map {UInt8($0 % 251)}
    _ = try upgraded.paint(paint,verify:true)
    try check(Set(latest.indices) == Set(UInt8(0)...UInt8(79)) && Array(latest.colors.prefix(240)) == Array(paint.prefix(240)),"new Kick sends 80 exact RGB key records from the persistent 84-slot canvas")
    try check(Array(latest.colors.suffix(15)) == Array(originalColors.suffix(15)),"Kick per-key output preserves all five side lights")
    latest.profile = 1; _ = try upgraded.status(); let writesBeforeProfile = latest.writes
    do { _ = try upgraded.arm(); throw failure("SELF_TEST","second profile leased an already leased global palette") }
    catch let e as BridgeError { try check(e.code == "RECOVERY_REQUIRED" && latest.writes == writesBeforeProfile,"global Kick palette cannot leak into another profile baseline") }
    latest.profile = 0; _ = try upgraded.status(); _ = try upgraded.restore()
    try check(latest.colors == originalColors && latest.state == originalState && !upgraded.recoveryPending,"new Kick restores the exact original global palette and current-profile state")
    latest.state[0] = 21; latest.state[1] = 37
    let dimmed = latest.state
    _ = try upgraded.arm(); _ = try upgraded.paint(Array(repeating:9,count:252),verify:true); _ = try upgraded.restore()
    try check(latest.state == dimmed && latest.colors == originalColors,"Kick raw custom rendering can restore a dimmed mode21 baseline without the AIR legacy restriction")
    _ = try upgraded.disconnect()

}

// Model-parametric transport fixtures: no HID device is opened by these checks.
func testAdditionalModelLifecycles(_ check: (Bool,String) throws -> Void) throws {
    final class Board {
        let model:USBKeyboardModel
        var firmware:[UInt8]
        var state:[UInt8] = [6,50,2,0,1,0,0,5,128,0,60,2,0,0,255,0,0]
        var colors:[UInt8]
        var writes=0, profile:UInt8=0
        var indices=Set<Int>()
        init(_ model:USBKeyboardModel) {
            self.model=model
            let v=model.qualifiedFirmware.split(separator:".").map{UInt8($0)!}
            firmware=[v[2],v[1],v[0],170,v[3],0,0,0]
            colors=(0..<(model.totalCount*3)).map{UInt8($0 % 127)}
        }
        func exchange(_ frame:[UInt8]) throws -> [UInt8] {
            let cmd=frame[1],n=Int(frame[4]),address=Int(frame[5]) | Int(frame[6]) << 8
            var payload:[UInt8]
            switch cmd {
            case 0xa1:payload=firmware
            case 0xa0:payload=[profile,8,4,model.rows,model.columns,UInt8(128+model.extraKeys),0,0]
            case 0xd1:payload=[UInt8(model.totalCount)]
            case 0xd5:payload=state;payload[5]=UInt8(writes % 255);payload[13]=UInt8((writes+19) % 255)
            case 0xd2:payload=Array(colors[address..<(address+n)])
            case 0xb1,0xb2:payload=Array(repeating:0,count:n)
            case 0xd6:
                writes+=1;payload=Array(frame[8..<(8+n)])
                for i in 0..<n where ![5,13].contains(address+i) {state[address+i]=payload[i]}
            case 0xd8:
                writes+=1;payload=Array(frame[8..<(8+n)])
                for offset in stride(from:0,to:n,by:4) {
                    let i=Int(payload[offset])
                    guard i<model.keyCount else {throw failure("SELF_TEST","D8 touched non-key slot")}
                    indices.insert(i)
                    // D2 compacts the immutable firmware matrix map.
                    guard let logical=model.rgbWriteIndices.firstIndex(of:i) else {throw failure("SELF_TEST","unknown physical RGB address")}
                    colors.replaceSubrange(logical*3..<(logical*3+3),with:payload[(offset+1)..<(offset+4)])
                }
            default:throw failure("SELF_TEST","Unexpected model fixture command")
            }
            guard payload.count==n else {throw failure("SELF_TEST","Model fixture reply size")}
            var reply=[UInt8](repeating:0,count:64);reply[0]=0xaa;reply[1]=cmd
            reply.replaceSubrange(4..<8,with:frame[4..<8]);reply.replaceSubrange(8..<(8+n),with:payload)
            reply[3]=S4.checksum(reply);return reply
        }
    }
    let dir=FileManager.default.temporaryDirectory.appendingPathComponent("nuphylab-model-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
    defer {try? FileManager.default.removeItem(at:dir)}
    var paths=Set<String>()
    for model in USBKeyboardModel.allCases where model != .air75 && model != .kick75 {
        let board=Board(model),originalState=Board(model).state,originalColors=Board(model).colors
        let device=Air75Device(backupURL:dir.appendingPathComponent("original.json"),testModel:model,testExchange:board.exchange)
        let info=try device.connect(),caps=info["capabilities"] as? [String:Any] ?? [:]
        try check(info["modelId"] as? String == model.rawValue && device.ledCount==model.totalCount,"\(model) exact USB/LED identity")
        try check(caps["perKey"] as? Bool == true && caps["connectionWake"] as? Bool == true && caps["boardSleepLease"] as? Bool == false,"\(model) qualified lighting without AIR sleep commands")
        let map=try device.readKeymap()
        try check(map["keymapKeyCount"] as? Int == model.keymapKeyCount && map["matrixKeyCount"] as? Int == model.matrixKeyCount,"\(model) full matrix and all touchbar/encoder entries")
        try check(caps["functionKeyAdaptation"] as? Bool == (model != .air65),"\(model) physical function-row capability")
        for offset in 0..<17 {
            var changed=originalState;changed[offset] ^= 1
            try check(S4.statesMatch(originalState,changed,firmware:board.firmware,model:model) == [5,13].contains(offset),"\(model) only the proven unpopulated fields may drift")
        }
        _ = try device.armConnectionWake()
        try check(board.colors.prefix(model.keyCount*3).allSatisfy{$0==0},"\(model) wake black frame verified")
        try check(paths.insert(device.backupURL.path).inserted,"\(model) distinct recovery namespace")
        let paint=(0..<(model.canvasCount*3)).map{UInt8($0 % 251)}
        _ = try device.paint(paint,verify:true)
        try check(board.indices==Set(0..<model.keyCount) && Array(board.colors.prefix(model.keyCount*3))==Array(paint.prefix(model.keyCount*3)),"\(model) every key including indices above 83 receives exact RGB")
        try check(Array(board.colors.suffix(model.sideCount*3))==Array(originalColors.suffix(model.sideCount*3)),"\(model) per-key writes exclude side LEDs")
        board.profile=1;_ = try device.status();let beforeProfile=board.writes
        do {_ = try device.arm();throw failure("SELF_TEST","cross-profile global palette lease")}
        catch let error as BridgeError {try check(error.code=="RECOVERY_REQUIRED" && board.writes==beforeProfile,"\(model) retains global palette owner across profile switch")}
        board.profile=0;_ = try device.status();_ = try device.restore()
        try check(board.state==originalState && board.colors==originalColors && !device.recoveryPending,"\(model) exact state and palette restored")
        _ = try device.disconnect()
        for versionDelta:UInt8 in [255,1] {
            let unqualified=Board(model);unqualified.firmware[0] &+= versionDelta
            let reader=Air75Device(backupURL:dir.appendingPathComponent("unknown.json"),testModel:model,testExchange:unqualified.exchange)
            let status=try reader.connect()
            try check(status["readOnly"] as? Bool == true,"\(model) unqualified older/future firmware stays read-only")
            do {_ = try reader.armConnectionWake();throw failure("SELF_TEST","unknown firmware armed")}
            catch let error as BridgeError {try check(error.code=="CONNECTION_WAKE_UNSUPPORTED" && unqualified.writes==0,"\(model) no unknown-firmware writes")}
            _ = try reader.disconnect()
        }
    }
}

func testDshJsonRpcAndRenderingLifecycle(_ check: (Bool, String) throws -> Void) throws {
    let session = DshJsonRpcSession()
    try check(!session.hasActiveSlots && session.focusedSlot == 1, "initial DSH session is inactive on slot 1")

    // 1. Snapshot notification
    let snapshotJson = """
    {"jsonrpc":"2.0","method":"peripheral/snapshot","params":{"focusedSlot":2,"slots":[{"slotIndex":1,"sessionId":"s1","status":"IDLE","brainpower":"low"},{"slotIndex":2,"sessionId":"s2","status":"RUNNING","brainpower":"high"},{"slotIndex":3,"sessionId":"s3","status":"COMPLETED","brainpower":"medium"},{"slotIndex":4,"sessionId":"s4","status":"ERROR","brainpower":"max"}]}}
    """
    let snapAction = try session.handleIncomingJson(snapshotJson, nowMs: 1000.0)
    try check(snapAction == .renderRequired(sideChanged: true), "snapshot triggers full + side render")
    try check(session.focusedSlot == 2 && session.hasActiveSlots, "snapshot updates focusedSlot and active slots")

    // Check unpulsed frame at elapsed=0 (cos(0)=1 -> pulse=1.0)
    let frame0 = session.renderFrame(nowMs: 1000.0, brightness: 1.0, pulseFocused: true)
    try check(frame0.count == 252, "DSH renderer emits 252 bytes for 84 keys")
    // F1 (index 1, unfocused IDLE) = round(255 * 0.35) = 89
    try check(Array(frame0[3..<6]) == [89, 89, 89], "unfocused IDLE slot dims white to 35%")
    // F2 (index 2, focused RUNNING at t=0 -> pulse=1.0) = [0x30, 0x4F, 0xFE] = [48, 79, 254]
    try check(Array(frame0[6..<9]) == [0x30, 0x4F, 0xFE], "focused RUNNING slot renders Codex Micro blue #304FFE at peak")
    // F3 (index 3, COMPLETED) = [0x00, 0xFF, 0x4C]
    try check(Array(frame0[9..<12]) == [0x00, 0xFF, 0x4C], "COMPLETED slot renders Codex Micro green #00FF4C")
    // F4 (index 4, ERROR) = [0xFF, 0x00, 0x33]
    try check(Array(frame0[12..<15]) == [0xFF, 0x00, 0x33], "ERROR slot renders Codex Micro red #FF0033")
    // F5 (index 5, INACTIVE) = [0, 0, 0]
    try check(Array(frame0[15..<18]) == [0, 0, 0], "INACTIVE slot stays off")

    // Check breathing trough at elapsed=900ms (half of 1800ms period -> cos(pi)=-1 -> pulse=0.28)
    let frameHalf = session.renderFrame(nowMs: 1900.0, brightness: 1.0, pulseFocused: true)
    let expectedTrough = DshFrameRenderer.scaleRGB((0x30, 0x4F, 0xFE), factor: 0.28)
    try check(Array(frameHalf[6..<9]) == [expectedTrough.0, expectedTrough.1, expectedTrough.2], "focused slot breathes to 28% at 900ms trough")
    try check(Array(frameHalf[9..<12]) == [0x00, 0xFF, 0x4C], "unfocused active slot remains steady during breathing")

    // 2. SlotUpdated notification -> NEEDS_INPUT on focused slot 2
    let updateJson = """
    {"jsonrpc":"2.0","method":"peripheral/slotUpdated","params":{"slotIndex":2,"sessionId":"s2","status":"NEEDS_INPUT","activeTool":"bash","question":{"prompt":"Allow command?","options":["ACCEPT","REJECT","ALWAYS_ALLOW"]}}}
    """
    let updateAction = try session.handleIncomingJson(updateJson, nowMs: 2000.0)
    try check(updateAction == .renderRequired(sideChanged: true), "updating focused slot updates side bar")
    let approvalFrame = session.renderFrame(nowMs: 1000.0, brightness: 1.0, pulseFocused: false)
    // F2 (index 2) is now #FF6D00 ([255, 109, 0])
    try check(Array(approvalFrame[6..<9]) == [0xFF, 0x6D, 0x00], "NEEDS_INPUT slot renders amber #FF6D00")
    // Enter (index 57) and Y (index 36) are #00FF4C
    try check(Array(approvalFrame[(57*3)..<(57*3+3)]) == [0x00, 0xFF, 0x4C], "Enter key highlights green for ACCEPT")
    try check(Array(approvalFrame[(36*3)..<(36*3+3)]) == [0x00, 0xFF, 0x4C], "Y key highlights green for ACCEPT")
    // Esc (index 0) and N (index 65) are #FF0033
    try check(Array(approvalFrame[0..<3]) == [0xFF, 0x00, 0x33], "Esc key highlights red for REJECT")
    try check(Array(approvalFrame[(65*3)..<(65*3+3)]) == [0xFF, 0x00, 0x33], "N key highlights red for REJECT")
    // Number keys 1, 2, 3 (indices 16, 17, 18) are #FF6D00
    for idx in [16, 17, 18] {
        try check(Array(approvalFrame[(idx*3)..<(idx*3+3)]) == [0xFF, 0x6D, 0x00], "Option key \(idx-15) highlights amber")
    }

    // 3. Outgoing JSON-RPC 2.0 request builders
    let switchReq = try session.buildSwitchFocusRequest(slotIndex: 3)
    try check(switchReq.contains("\"method\":\"peripheral/switchFocus\"") && switchReq.contains("\"slotIndex\":3"), "switchFocus JSON-RPC request")
    let bpReq = try session.buildSetBrainpowerRequest(direction: "stepUp")
    try check(bpReq.contains("\"method\":\"peripheral/setBrainpower\"") && bpReq.contains("\"direction\":\"stepUp\""), "setBrainpower JSON-RPC request")
    let optReq = try session.buildSelectOptionRequest(action: "REJECT")
    try check(optReq.contains("\"method\":\"peripheral/selectOption\"") && optReq.contains("\"optionIndex\":1") && optReq.contains("\"action\":\"REJECT\""), "selectOption JSON-RPC request")

    // 4. In-memory virtual hardware pipeline: arm, per-key D8 painting & side light verification
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }

    final class DshVirtualBoard {
        var state: [UInt8] = [6, 50, 2, 0, 1, 0, 0, 5, 128, 4, 60, 2, 1, 0, 255, 0, 0, 0, 0, 0, 0, 0]
        var colors = [UInt8](repeating: 0, count: 312)
        var d8Packets = 0
        var key: UInt8 = 0

        func exchange(_ frame: [UInt8]) throws -> [UInt8] {
            let command = frame[1]
            let length = Int(frame[4] ^ key)
            let address = Int(frame[5] ^ key) | (Int(frame[6] ^ key) << 8)
            var payload: [UInt8]
            switch command {
            case 0xa1:
                key = 0
                payload = [23, 0, 1, 0xaa, 6, 0, 0, 0]
            case 0xa0:
                payload = [0, 8, 4, 6, 16, 2, 0, 0]
            case 0xd1:
                payload = [104]
            case 0xd5:
                payload = state
            case 0xd6:
                payload = frame[8..<(8 + length)].map { $0 ^ key }
                state.replaceSubrange(address..<(address + length), with: payload)
            case 0xd7:
                payload = [0]
            case 0xd2:
                let rendered = S4.renderedCustomColors(Array(colors.prefix(252)), firmware: [23, 0, 1, 0xaa, 6, 0, 0, 0], model: .air75) + Array(colors.dropFirst(252))
                payload = Array(rendered[address..<(address + length)])
            case 0xd8:
                d8Packets += 1
                payload = frame[8..<(8 + length)].map { $0 ^ key }
                for offset in stride(from: 0, to: length, by: 4) {
                    let index = Int(payload[offset])
                    let start = index * 3
                    if start + 3 <= colors.count {
                        colors.replaceSubrange(start..<(start + 3), with: payload[(offset + 1)..<(offset + 4)])
                    }
                }
            default:
                throw failure("SELF_TEST", "Unexpected command in DSH board test: \(String(format: "0x%02x", command))")
            }
            var reply = [UInt8](repeating: 0, count: 64)
            reply[0] = 0xaa
            reply[1] = command
            reply.replaceSubrange(4..<8, with: frame[4..<8])
            for (i, v) in payload.prefix(length).enumerated() {
                reply[8 + i] = v ^ key
            }
            reply[3] = S4.checksum(reply)
            return reply
        }
    }

    let board = DshVirtualBoard()
    let device = Air75Device(backupURL: dir.appendingPathComponent("lighting-backup.json"), testProductId: 0x1028, testExchange: { frame in
        try board.exchange(frame)
    })

    let firstSync = try session.syncToDevice(device, nowMs: 1000.0, updateSide: true, verify: true, pulseFocused: false)
    try check(firstSync["verification"] as? String == "readback" && board.d8Packets == 7, "first DSH sync arms board, paints 84 keys in 7 packets, and verifies D2 readback")
    try check(Array(board.state[14..<17]) == [0xFF, 0x6D, 0x00] && board.state[10] == 60, "side bar syncs to focused slot NEEDS_INPUT amber")
    board.d8Packets = 0
    // Next frame at +100ms only pulses focused slot 2 and interactive keys (9 keys total -> 1 D8 packet!)
    _ = try session.syncToDevice(device, nowMs: 1100.0, updateSide: false, verify: false, pulseFocused: true)
    try check(board.d8Packets == 1, "subsequent animated DSH frame sends only 1 delta D8 packet (<= 13 changed keys)")
    try check(device.shutdown(), "DSH virtual board restores original lighting cleanly on shutdown")

    // 5. 8-Model profile matrix validation
    for profile in NuphyDeviceProfile.supported {
        let resolved = NuphyDeviceProfile.resolve(productID: profile.wiredPID)
        try check(resolved?.transport == "USB" && resolved?.isDongle == false && resolved?.profile.model == profile.model, "\(profile.model) resolves to USB wired profile")
    }
    try check(NuphyDeviceProfile.allowedProductIDs.count == 8, "allowedProductIDs includes exactly the 8 supported wired models")

    // 6. Bluetooth fallback transport & CapsLock LED tests
    try check(BluetoothKeyboard.shouldIlluminateCapsLockLED(status: .needsInput, elapsedMs: 100.0) == true, "Bluetooth fallback LED illuminates during first half of 1Hz NEEDS_INPUT cycle")
    try check(BluetoothKeyboard.shouldIlluminateCapsLockLED(status: .needsInput, elapsedMs: 650.0) == false, "Bluetooth fallback LED extinguishes during second half of 1Hz NEEDS_INPUT cycle")
    try check(BluetoothKeyboard.shouldIlluminateCapsLockLED(status: .error, elapsedMs: 50.0) == true && BluetoothKeyboard.shouldIlluminateCapsLockLED(status: .error, elapsedMs: 950.0) == false, "Bluetooth fallback LED flashes 3 times then stops on ERROR")
    try check(BluetoothKeyboard.shouldIlluminateCapsLockLED(status: .running, elapsedMs: 100.0) == false, "Bluetooth fallback LED stays off on RUNNING")

    let transportRpc = try session.buildTransportChangedNotification(
        transport: "bluetooth",
        model: "NuPhy Air75 V3",
        vendorId: 0x05AC,
        productId: 0x024F,
        rgb: false,
        keys: true,
        ledBlink: true,
        wireless: true
    )
    try check(transportRpc.contains("\"method\":\"peripheral/transportChanged\"") && transportRpc.contains("\"transport\":\"bluetooth\"") && transportRpc.contains("\"rgb\":false"), "buildTransportChangedNotification serializes Bluetooth fallback capabilities")
}


func selfTest() throws {
    var checks = 0
    func check(_ yes: Bool, _ name: String) throws {
        if !yes { throw failure("SELF_TEST", name) }
        checks += 1
    }

    try testBoardSleepLifecycle(check)
    try testKickLifecycle(check)
    try testAdditionalModelLifecycles(check)
    try testDshJsonRpcAndRenderingLifecycle(check)

    emit(["ok": true, "selfTest": "passed", "checks": checks, "hardwareOpened": false, "inputMonitorOpened": false])
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--self-test") {
    do { try selfTest(); Darwin.exit(0) } catch { diagnostic("\(error)"); Darwin.exit(1) }
}
if arguments.contains("--help") || arguments.contains("-h") {
    print("""
    dsh-daemon [--ws <ws://127.0.0.1:45678/peripheral/v1>] [--daemon] [--backup /absolute/path.json] [--self-test]
    Swift 6 Native Hardware Daemon & S4 HID Bridge for DeepSeek Harness (dsh-hid).
    - Without --ws/--daemon: runs in JSONL stdin/stdout bridge mode (compatible with Air75 Studio protocol).
    - With --daemon or --ws <url>: connects directly to DSH Peripheral JSON-RPC 2.0 WebSocket Server.
    """)
    Darwin.exit(0)
}
var backupPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/dsh-hid/lighting-backup.json").path
var wsUrlString: String? = nil
var index = 0
while index < arguments.count {
    let arg = arguments[index]
    if arg == "--backup" {
        guard index + 1 < arguments.count, arguments[index + 1].hasPrefix("/") else {
            diagnostic("Use --backup followed by an absolute path."); Darwin.exit(64)
        }
        backupPath = arguments[index + 1]; index += 2
    } else if arg == "--ws" {
        guard index + 1 < arguments.count else {
            diagnostic("Use --ws followed by a WebSocket URL."); Darwin.exit(64)
        }
        wsUrlString = arguments[index + 1]; index += 2
    } else if arg.hasPrefix("--ws=") {
        wsUrlString = String(arg.dropFirst("--ws=".count)); index += 1
    } else if arg == "--daemon" {
        if wsUrlString == nil { wsUrlString = "ws://127.0.0.1:45678/peripheral/v1" }
        index += 1
    } else {
        diagnostic("Unknown argument: \(arg). Use --help for usage."); Darwin.exit(64)
    }
}
// Ignore SIGPIPE so shutdown can still restore when the parent closes stdout.
signal(SIGPIPE, SIG_IGN)
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN); signal(SIGHUP, SIG_IGN)
let server = JSONServer(device: Air75Device(backupURL: URL(fileURLWithPath: backupPath)))
var wsDaemon: DshWebSocketDaemon? = nil
if let wsUrlString = wsUrlString {
    guard let url = URL(string: wsUrlString), ["ws", "wss"].contains(url.scheme?.lowercased() ?? "") else {
        diagnostic("Invalid WebSocket URL: \(wsUrlString)"); Darwin.exit(64)
    }
    let daemon = DshWebSocketDaemon(url: url, server: server)
    server.wsDaemon = daemon
    wsDaemon = daemon
    daemon.start()
}
let signals = [SIGINT, SIGTERM, SIGHUP].map { value -> DispatchSourceSignal in
    let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
    source.setEventHandler {
        wsDaemon?.stop()
        server.shutdown()
    }
    source.resume()
    return source
}
let hasWsDaemon = (wsDaemon != nil)
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        if line.utf8.count > 32768 {
            DispatchQueue.main.async { emit(["id": NSNull(), "ok": false, "error": failure("REQUEST_TOO_LARGE", "A JSONL request must be smaller than 32 KiB.").json]) }
            continue
        }
        DispatchQueue.main.async {
            do {
                guard let command = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                    throw failure("INVALID_JSON", "Every line must be a JSON object.")
                }
                server.enqueue(command)
            } catch {
                emit(["id": NSNull(), "ok": false, "error": failure("INVALID_JSON", "Invalid JSON request.").json])
            }
        }
    }
    if !hasWsDaemon {
        DispatchQueue.main.async { server.finishInput() }
    } else {
        DispatchQueue.main.async {
            wsDaemon?.stop()
            server.shutdown()
        }
    }
}
if hasWsDaemon {
    let ppidCheckTimer = DispatchSource.makeTimerSource(queue: .main)
    ppidCheckTimer.schedule(deadline: .now() + 1.0, repeating: 1.0)
    ppidCheckTimer.setEventHandler {
        if getppid() == 1 {
            diagnostic("Parent process terminated. Shutting down daemon cleanly.")
            wsDaemon?.stop()
            server.shutdown()
        }
    }
    ppidCheckTimer.resume()
}
CFRunLoopRun()
