package chat.crud.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Receives things shared to CRUD.chat from other apps (Android's share sheet): photos, PDFs, spreadsheets,
 * text and links. MainActivity's intent filters route ACTION_SEND / ACTION_SEND_MULTIPLE here.
 *
 * The page (crud.chat/app) calls Capacitor.nativePromise("ShareIn", "take") after it loads, and again when the
 * window event "crudshare" fires (a share arriving while the app is open). It then asks which workspace to send
 * to. Items: { name, type, data (base64) } for files, { text } for text and links, { name, tooLarge: true }.
 */
@CapacitorPlugin(name = "ShareIn")
public class ShareInPlugin extends Plugin {
    private static final long MAX_BYTES = 15L * 1024 * 1024; // larger files aren't read
    private static final int MAX_IMAGE_SIDE = 2048;          // photos are scaled down and sent as JPEG

    private final List<Uri> pendingUris = new ArrayList<>();
    private final List<String> pendingTexts = new ArrayList<>();

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        if (collect(intent)) getActivity().setIntent(new Intent(Intent.ACTION_MAIN)); // don't pick it up twice
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (collect(intent)) bridge.triggerWindowJSEvent("crudshare");
    }

    /** Keeps what was shared until the page takes it. Returns true if the intent was a share. */
    private synchronized boolean collect(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) pendingUris.add(uri);
        } else {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) for (Uri u : uris) if (u != null) pendingUris.add(u);
        }
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.toString().trim().length() > 0) pendingTexts.add(text.toString());
        else {
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (subject != null && subject.trim().length() > 0 && pendingUris.isEmpty()) pendingTexts.add(subject);
        }
        return true;
    }

    @PluginMethod
    public void take(PluginCall call) {
        List<Uri> uris;
        List<String> texts;
        synchronized (this) {
            uris = new ArrayList<>(pendingUris);
            texts = new ArrayList<>(pendingTexts);
            pendingUris.clear();
            pendingTexts.clear();
        }
        JSArray items = new JSArray();
        for (Uri uri : uris) {
            try { items.put(read(uri)); } catch (Exception e) { /* skip what can't be read */ }
        }
        for (String t : texts) { JSObject o = new JSObject(); o.put("text", t); items.put(o); }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    private JSObject read(Uri uri) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String name = "file", type = cr.getType(uri);
        long size = -1;
        try (Cursor c = cr.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && c.getString(n) != null) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
            }
        } catch (Exception ignored) { }
        if (name.equals("file") && uri.getLastPathSegment() != null) name = uri.getLastPathSegment();
        if (type == null) type = "application/octet-stream";
        JSObject o = new JSObject();
        o.put("name", name);
        if (size > MAX_BYTES) { o.put("tooLarge", true); return o; }

        byte[] bytes = readAll(cr, uri);
        if (bytes == null) { o.put("tooLarge", true); return o; }
        if (type.startsWith("image/") && !type.equals("image/gif")) {
            byte[] jpeg = toJpeg(bytes);
            if (jpeg != null) {
                bytes = jpeg;
                type = "image/jpeg";
                o.put("name", name.replaceAll("\\.[A-Za-z0-9]+$", "") + ".jpg");
            }
        }
        o.put("type", type);
        o.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return o;
    }

    private static byte[] readAll(ContentResolver cr, Uri uri) throws Exception {
        try (InputStream in = cr.openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) return null;
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    /** Any photo (including HEIC on Android 9+) → JPEG no larger than MAX_IMAGE_SIDE, or null. */
    private static byte[] toJpeg(byte[] bytes) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_IMAGE_SIDE) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
            if (bmp == null) return null;
            int w = bmp.getWidth(), h = bmp.getHeight(), side = Math.max(w, h);
            if (side > MAX_IMAGE_SIDE) {
                float k = (float) MAX_IMAGE_SIDE / side;
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.round(w * k), Math.round(h * k), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 88, out);
            bmp.recycle();
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }
}
