import UIKit
import UniformTypeIdentifiers

/// "CRUD.chat" in the iOS share sheet. Saves what was shared (photos, PDFs, spreadsheets, text, links) into the
/// App Group inbox, then opens the app, where the person picks the workspace and sends it.
@objc(ShareViewController)
class ShareViewController: UIViewController {
    private let label = UILabel()
    private let button = UIButton(type: .system)
    private static let maxImageSide: CGFloat = 2048

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor { $0.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1) : UIColor(red: 0.957, green: 0.949, blue: 0.925, alpha: 1) }
        label.text = "Opening CRUD.chat…"
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 0
        button.setTitle("Done", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.isHidden = true
        button.addTarget(self, action: #selector(done), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [label, button])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
        ])
        Task { await handle() }
    }

    private func handle() async {
        guard let inbox = ShareInbox.folder else { show("Couldn’t share to CRUD.chat. Please update the app and try again."); return }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var saved: [ShareInbox.Entry] = []
        for p in providers {
            if let e = await save(p, into: inbox) { saved.append(e) }
        }
        if saved.isEmpty { show("CRUD.chat can read photos, PDFs, Excel or CSV files, and text."); return }
        ShareInbox.append(saved)
        if openApp() {
            try? await Task.sleep(nanoseconds: 300_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            show("Saved. Open CRUD.chat to choose the workspace and send it.")
        }
    }

    private func show(_ text: String) {
        label.text = text
        button.isHidden = false
    }

    @objc private func done() { extensionContext?.completeRequest(returningItems: nil) }

    /// Opens the app with crudchat://share (extensions can't call UIApplication.shared directly).
    private func openApp() -> Bool {
        guard let url = URL(string: "crudchat://share") else { return false }
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return true
            }
            responder = r.next
        }
        return false
    }

    // MARK: - Reading what was shared

    private static let fileTypes: [UTType] = [
        .pdf, .commaSeparatedText, .spreadsheet,
        UTType("org.openxmlformats.spreadsheetml.sheet") ?? .spreadsheet,
        UTType("com.microsoft.excel.xls") ?? .spreadsheet,
    ]

    private func save(_ p: NSItemProvider, into dir: URL) async -> ShareInbox.Entry? {
        // Documents and spreadsheets: keep the file as it is.
        for t in Self.fileTypes where p.hasItemConformingToTypeIdentifier(t.identifier) {
            if let e = await copyFile(p, type: t, into: dir) { return e }
        }
        // Photos: scaled down and saved as JPEG (HEIC and RAW included).
        if p.hasItemConformingToTypeIdentifier(UTType.image.identifier),
           let img = await loadImage(p), let e = writeJpeg(img, name: p.suggestedName, into: dir) { return e }
        // Text (a message, a note) or a text file.
        if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            let item = await loadItem(p, UTType.plainText.identifier)
            if let s = item as? String, !s.isEmpty { return .init(text: s) }
            if let d = item as? Data, let s = String(data: d, encoding: .utf8), !s.isEmpty { return .init(text: s) }
            if let u = item as? URL, u.isFileURL { return copy(from: u, name: u.lastPathComponent, into: dir) }
        }
        // A link from Safari or another app.
        if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let u = await loadItem(p, UTType.url.identifier) as? URL {
            return u.isFileURL ? copy(from: u, name: u.lastPathComponent, into: dir) : .init(text: u.absoluteString)
        }
        // Anything else: pass it on; the app says if it can't read it.
        if p.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            return await copyFile(p, type: .data, into: dir)
        }
        return nil
    }

    private func loadItem(_ p: NSItemProvider, _ id: String) async -> NSSecureCoding? {
        await withCheckedContinuation { c in p.loadItem(forTypeIdentifier: id, options: nil) { item, _ in c.resume(returning: item) } }
    }

    private func copyFile(_ p: NSItemProvider, type: UTType, into dir: URL) async -> ShareInbox.Entry? {
        await withCheckedContinuation { c in
            p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                // The file only exists until this handler returns, so copy it now.
                guard let url = url else { c.resume(returning: nil); return }
                c.resume(returning: self.copy(from: url, name: p.suggestedName.map { n in
                    n.contains(".") ? n : n + "." + url.pathExtension } ?? url.lastPathComponent, into: dir))
            }
        }
    }

    nonisolated private func copy(from url: URL, name: String, into dir: URL) -> ShareInbox.Entry? {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > ShareInbox.maxBytes { return .init(name: name, tooLarge: true) }
        let file = UUID().uuidString + "-" + name.replacingOccurrences(of: "/", with: "-")
        do { try FileManager.default.copyItem(at: url, to: dir.appendingPathComponent(file)) } catch { return nil }
        let ext = (name as NSString).pathExtension
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        return .init(file: file, name: name, type: mime)
    }

    private func loadImage(_ p: NSItemProvider) async -> UIImage? {
        let item = await loadItem(p, UTType.image.identifier)
        if let img = item as? UIImage { return img }
        if let d = item as? Data { return UIImage(data: d) }
        if let u = item as? URL, let d = try? Data(contentsOf: u) { return UIImage(data: d) }
        return nil
    }

    private func writeJpeg(_ img: UIImage, name: String?, into dir: URL) -> ShareInbox.Entry? {
        autoreleasepool {
            let side = max(img.size.width, img.size.height)
            var out = img
            if side > Self.maxImageSide {
                let k = Self.maxImageSide / side
                let size = CGSize(width: (img.size.width * k).rounded(), height: (img.size.height * k).rounded())
                let fmt = UIGraphicsImageRendererFormat.default()
                fmt.scale = 1
                out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
            }
            guard let data = out.jpegData(compressionQuality: 0.88) else { return nil }
            let base = ((name ?? "Photo") as NSString).deletingPathExtension
            let display = (base.isEmpty ? "Photo" : base) + ".jpg"
            let file = UUID().uuidString + ".jpg"
            do { try data.write(to: dir.appendingPathComponent(file)) } catch { return nil }
            return .init(file: file, name: display, type: "image/jpeg")
        }
    }
}
