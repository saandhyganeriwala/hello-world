import Foundation
import Capacitor
import StoreKit

/// In-app purchases with StoreKit 2. Called from the web app as `Capacitor.nativePromise("Store", method, options)`.
///
/// The page (crud.chat/app) sends every transaction it gets from here to our server, which verifies it with
/// Apple and switches the workspace to Pro. Only then does the page call `finish`. Transactions that weren't
/// finished (the app closed mid-purchase, a renewal while the app was closed) are picked up with `unfinished`.
@objc(StorePlugin)
public class StorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StorePlugin"
    public let jsName = "Store"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manage", returnType: CAPPluginReturnPromise)
    ]

    private var updates: Task<Void, Never>?

    override public func load() {
        // Apple asks apps to listen for transactions from the start. We leave them unfinished so the page can
        // send them to the server (via `unfinished`) and finish them once Pro is recorded.
        updates = Task.detached { for await _ in Transaction.updates {} }
    }

    deinit { updates?.cancel() }

    @objc func getProducts(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        Task {
            do {
                let products = try await Product.products(for: ids)
                call.resolve(["products": products.map { p -> [String: Any] in
                    var period = ""
                    if let unit = p.subscription?.subscriptionPeriod.unit {
                        switch unit {
                        case .day: period = "day"
                        case .week: period = "week"
                        case .month: period = "month"
                        case .year: period = "year"
                        @unknown default: period = ""
                        }
                    }
                    return ["id": p.id, "title": p.displayName, "description": p.description, "price": p.displayPrice, "period": period]
                }])
            } catch {
                call.reject("Couldn't load the subscription from the App Store: \(error.localizedDescription)")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else { call.reject("productId is missing"); return }
        let token = call.getString("accountToken").flatMap { UUID(uuidString: $0) }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("The subscription isn't available in the App Store yet.")
                    return
                }
                var options: Set<Product.PurchaseOption> = []
                if let token = token { options.insert(.appAccountToken(token)) }
                let result = try await product.purchase(options: options)
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let tx):
                        call.resolve(["status": "purchased", "jws": verification.jwsRepresentation, "transactionId": String(tx.id)])
                    case .unverified(_, let err):
                        call.reject("The App Store couldn't verify that purchase: \(err.localizedDescription)")
                    }
                case .pending:
                    call.resolve(["status": "pending"])   // e.g. Ask to Buy — arrives later as an unfinished transaction
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.resolve(["status": "unknown"])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let idString = call.getString("transactionId"), let id = UInt64(idString) else { call.reject("transactionId is missing"); return }
        Task {
            for await result in Transaction.unfinished {
                if case .verified(let tx) = result, tx.id == id { await tx.finish() }
            }
            call.resolve()
        }
    }

    @objc func unfinished(_ call: CAPPluginCall) {
        Task {
            var list: [[String: Any]] = []
            for await result in Transaction.unfinished {
                if case .verified(let tx) = result {
                    list.append(["jws": result.jwsRepresentation, "transactionId": String(tx.id)])
                }
            }
            call.resolve(["transactions": list])
        }
    }

    /// "Restore purchases": syncs with the App Store (may ask the person to sign in), then returns current subscriptions.
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            try? await AppStore.sync()
            var list: [[String: Any]] = []
            for await result in Transaction.currentEntitlements {
                if case .verified(let tx) = result, tx.productType == .autoRenewable {
                    list.append(["jws": result.jwsRepresentation, "transactionId": String(tx.id)])
                }
            }
            call.resolve(["transactions": list])
        }
    }

    /// Opens Apple's own "manage subscription" sheet (to cancel or change).
    @objc func manage(_ call: CAPPluginCall) {
        Task { @MainActor in
            if let scene = self.bridge?.viewController?.view.window?.windowScene {
                try? await AppStore.showManageSubscriptions(in: scene)
            } else if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
                await UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }
}
