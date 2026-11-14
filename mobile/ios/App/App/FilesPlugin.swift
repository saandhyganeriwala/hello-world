import Foundation
import Capacitor
import UIKit

/// Saves exported files where people can find them, and opens the share menu for them.
/// Called from the web app as `Capacitor.nativePromise("Files", "save" | "share", options)`.
///   save  { files: [{ name, mime, data (base64) }] } → { where, names }
///   share { names: [...] }
/// Files go in the app's Documents folder, which the Files app shows under On My iPhone → CRUD.chat
/// (Info.plist: UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace).
@objc(FilesPlugin)
public class FilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FilesPlugin"
    public let jsName = "Files"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    private var documents: URL? { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first }

    private func clean(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        let s = name.components(separatedBy: bad).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "Export.csv" : s
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let dir = documents else { call.reject("No Documents folder"); return }
        let files = call.getArray("files", JSObject.self) ?? []
        if files.isEmpty { call.reject("No files"); return }
        var names: [String] = []
        for f in files {
            let name = clean((f["name"] as? String) ?? "Export.csv")
            guard let data = Data(base64Encoded: (f["data"] as? String) ?? "") else { continue }
            do { try data.write(to: dir.appendingPathComponent(name), options: .atomic) } catch { call.reject("Couldn't save \(name)"); return }
            names.append(name)
        }
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "On My iPad" : "On My iPhone"
        call.resolve(["where": "the Files app → \(device) → CRUD.chat", "names": names])
    }

    @objc func share(_ call: CAPPluginCall) {
        guard let dir = documents else { call.reject("No Documents folder"); return }
        let urls = (call.getArray("names", String.self) ?? []).map { dir.appendingPathComponent(clean($0)) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        if urls.isEmpty { call.reject("Nothing to share"); return }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("No screen"); return }
            let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
            if let pop = sheet.popoverPresentationController { // iPad
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            vc.present(sheet, animated: true)
            call.resolve()
        }
    }
}
