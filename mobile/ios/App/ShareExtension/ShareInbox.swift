import Foundation

/// The hand-off between the Share Extension and the app: files and text shared to CRUD.chat wait in the
/// App Group container ("ShareInbox" folder + items.json) until the app's page takes them (ShareInPlugin).
/// Compiled into both the app and the extension.
enum ShareInbox {
    static let appGroup = "group.chat.crud.app"
    static let maxBytes = 15 * 1024 * 1024

    /// A shared file ({file, name, type}) or shared text ({text}).
    struct Entry: Codable {
        var file: String?
        var name: String?
        var type: String?
        var text: String?
        var tooLarge: Bool?
    }

    static var folder: URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let dir = base.appendingPathComponent("ShareInbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static var manifest: URL? { folder?.appendingPathComponent("items.json") }

    static func entries() -> [Entry] {
        guard let url = manifest, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    static var hasItems: Bool { !entries().isEmpty }

    static func append(_ new: [Entry]) {
        guard !new.isEmpty, let url = manifest else { return }
        let all = entries() + new
        if let data = try? JSONEncoder().encode(all) { try? data.write(to: url, options: .atomic) }
    }

    /// Removes everything (after the page has taken it).
    static func clear() {
        guard let dir = folder else { return }
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: f)
        }
    }
}
