import Foundation
import Capacitor
import UIKit

/// Hands what was shared to CRUD.chat (via the Share Extension) to the page. Called from the web app as
/// `Capacitor.nativePromise("ShareIn", "take")`; the page asks which workspace to send it to.
/// When the app comes to the front with something waiting, it fires the window event "crudshare".
@objc(ShareInPlugin)
public class ShareInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInPlugin"
    public let jsName = "ShareIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func becameActive() {
        if ShareInbox.hasItems { bridge?.triggerWindowJSEvent(eventName: "crudshare") }
    }

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let entries = ShareInbox.entries()
            var items: [[String: Any]] = []
            for e in entries {
                if let t = e.text { items.append(["text": t]); continue }
                let name = e.name ?? "file"
                if e.tooLarge == true { items.append(["name": name, "tooLarge": true]); continue }
                guard let f = e.file, let dir = ShareInbox.folder,
                      let data = try? Data(contentsOf: dir.appendingPathComponent(f)) else { continue }
                if data.count > ShareInbox.maxBytes { items.append(["name": name, "tooLarge": true]); continue }
                items.append(["name": name, "type": e.type ?? "application/octet-stream", "data": data.base64EncodedString()])
            }
            ShareInbox.clear()
            call.resolve(["items": items])
        }
    }
}
