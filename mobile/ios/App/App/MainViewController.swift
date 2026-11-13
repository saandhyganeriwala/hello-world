import UIKit
import Capacitor

/// The app's web view controller. Registers plugins that live in this app (not in npm packages).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(StorePlugin())
        bridge?.registerPluginInstance(ShareInPlugin())
    }
}
