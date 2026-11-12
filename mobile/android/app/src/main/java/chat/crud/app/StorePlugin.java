package chat.crud.app;

import android.content.Intent;
import android.net.Uri;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * In-app purchases with Google Play Billing. Called from the web app as
 * Capacitor.nativePromise("Store", method, options).
 *
 * The page sends each purchase token to our server, which checks it with Google, switches the workspace to Pro
 * and acknowledges the purchase (Google refunds purchases that aren't acknowledged within 3 days).
 */
@CapacitorPlugin(name = "Store")
public class StorePlugin extends Plugin implements PurchasesUpdatedListener {
    private BillingClient billing;
    private PluginCall pendingPurchase;

    @Override
    public void load() {
        billing = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build();
    }

    /** Runs `then` once connected to Google Play, or rejects the call. */
    private void whenReady(PluginCall call, Runnable then) {
        if (billing.isReady()) { then.run(); return; }
        billing.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) then.run();
                else call.reject("Google Play billing isn't available: " + result.getDebugMessage());
            }
            @Override public void onBillingServiceDisconnected() { /* reconnects on the next call */ }
        });
    }

    private QueryProductDetailsParams productQuery(List<String> ids) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(BillingClient.ProductType.SUBS).build());
        }
        return QueryProductDetailsParams.newBuilder().setProductList(products).build();
    }

    private static String priceOf(ProductDetails d) {
        List<ProductDetails.SubscriptionOfferDetails> offers = d.getSubscriptionOfferDetails();
        if (offers == null || offers.isEmpty()) return "";
        List<ProductDetails.PricingPhase> phases = offers.get(0).getPricingPhases().getPricingPhaseList();
        return phases.isEmpty() ? "" : phases.get(phases.size() - 1).getFormattedPrice();
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        List<String> ids = new ArrayList<>();
        try {
            JSArray arr = call.getArray("ids");
            if (arr != null) for (Object o : arr.toList()) ids.add(String.valueOf(o));
        } catch (Exception e) { call.reject("ids must be a list"); return; }
        whenReady(call, () -> billing.queryProductDetailsAsync(productQuery(ids), (result, details) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { call.reject("Couldn't load the subscription from Google Play: " + result.getDebugMessage()); return; }
            JSArray out = new JSArray();
            for (ProductDetails d : details.getProductDetailsList()) {
                JSObject p = new JSObject();
                p.put("id", d.getProductId());
                p.put("title", d.getName());
                p.put("description", d.getDescription());
                p.put("price", priceOf(d));
                p.put("period", "month");
                out.put(p);
            }
            JSObject ret = new JSObject();
            ret.put("products", out);
            call.resolve(ret);
        }));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        String productId = call.getString("productId");
        String account = call.getString("accountToken");
        if (productId == null) { call.reject("productId is missing"); return; }
        whenReady(call, () -> billing.queryProductDetailsAsync(productQuery(Collections.singletonList(productId)), (result, details) -> {
            List<ProductDetails> list = details.getProductDetailsList();
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || list == null || list.isEmpty()) {
                call.reject("The subscription isn't available on Google Play yet.");
                return;
            }
            ProductDetails d = list.get(0);
            List<ProductDetails.SubscriptionOfferDetails> offers = d.getSubscriptionOfferDetails();
            if (offers == null || offers.isEmpty()) { call.reject("The subscription has no active plan on Google Play."); return; }
            BillingFlowParams.ProductDetailsParams item = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(d).setOfferToken(offers.get(0).getOfferToken()).build();
            BillingFlowParams.Builder flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(Collections.singletonList(item));
            if (account != null && !account.isEmpty()) flow.setObfuscatedAccountId(account); // the workspace this is for
            getActivity().runOnUiThread(() -> {
                pendingPurchase = call;
                BillingResult launched = billing.launchBillingFlow(getActivity(), flow.build());
                if (launched.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    pendingPurchase = null;
                    call.reject("Couldn't open Google Play: " + launched.getDebugMessage());
                }
            });
        }));
    }

    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        PluginCall call = pendingPurchase;
        pendingPurchase = null;
        if (call == null) return; // e.g. a pending purchase completing later — the page picks it up with `unfinished`
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null && !purchases.isEmpty()) {
            Purchase p = purchases.get(0);
            JSObject ret = new JSObject();
            ret.put("status", p.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased" : "pending");
            ret.put("purchaseToken", p.getPurchaseToken());
            ret.put("orderId", p.getOrderId());
            call.resolve(ret);
        } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            JSObject ret = new JSObject();
            ret.put("status", "cancelled");
            call.resolve(ret);
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            JSObject ret = new JSObject();
            ret.put("status", "owned"); // the page restores instead
            call.resolve(ret);
        } else {
            call.reject("Google Play: " + result.getDebugMessage());
        }
    }

    private void listPurchases(PluginCall call) {
        whenReady(call, () -> billing.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
            (result, purchases) -> {
                JSArray out = new JSArray();
                for (Purchase p : purchases) {
                    if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
                    JSObject o = new JSObject();
                    o.put("purchaseToken", p.getPurchaseToken());
                    o.put("acknowledged", p.isAcknowledged());
                    out.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("purchases", out);
                call.resolve(ret);
            }));
    }

    /** Purchases not yet confirmed by our server (acknowledged = false). */
    @PluginMethod
    public void unfinished(PluginCall call) { listPurchases(call); }

    /** "Restore purchases": the person's active subscriptions on this Google account. */
    @PluginMethod
    public void restore(PluginCall call) { listPurchases(call); }

    /** Opens Google Play's subscription settings (to cancel or change). */
    @PluginMethod
    public void manage(PluginCall call) {
        String productId = call.getString("productId", "");
        Uri uri = Uri.parse("https://play.google.com/store/account/subscriptions?sku=" + productId + "&package=" + getContext().getPackageName());
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
