package chat.crud.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/**
 * Saves exported files where people can find them, and opens the share menu for them.
 * Called from the web app as Capacitor.nativePromise("Files", "save" | "share", options).
 *   save  { files: [{ name, mime, data (base64) }] } → { where, names }   (Downloads/CRUD.chat)
 *   share { names: [...] }                                                (files from the last save)
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {
    private static final String FOLDER = "CRUD.chat";

    @PluginMethod
    public void save(PluginCall call) {
        JSArray files = call.getArray("files");
        if (files == null || files.length() == 0) { call.reject("No files"); return; }
        JSArray names = new JSArray();
        String where;
        try {
            File shareDir = new File(getContext().getCacheDir(), "exports");
            shareDir.mkdirs();
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String name = clean(f.optString("name", "Export.csv"));
                String mime = f.optString("mime", "text/csv");
                byte[] bytes = Base64.decode(f.optString("data", ""), Base64.DEFAULT);
                // A copy for the share menu
                try (FileOutputStream out = new FileOutputStream(new File(shareDir, name))) { out.write(bytes); }
                names.put(saveToDownloads(name, mime, bytes));
            }
            where = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? "Downloads → " + FOLDER + " (open the Files app)"
                : "Android/data/" + getContext().getPackageName() + "/files/Download";
        } catch (Exception e) {
            call.reject("Couldn't save the file: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("where", where);
        ret.put("names", names);
        call.resolve(ret);
    }

    /** Writes to Downloads/CRUD.chat (Android 10+) and returns the name Android gave it (it adds " (1)" for repeats). */
    private String saveToDownloads(String name, String mime, byte[] bytes) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver cr = getContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("no Downloads folder");
            try (OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new Exception("can't write");
                out.write(bytes);
            }
            try (Cursor c = cr.query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
            } catch (Exception ignored) { }
            return name;
        }
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = new File(getContext().getFilesDir(), "Download");
        dir.mkdirs();
        try (FileOutputStream out = new FileOutputStream(new File(dir, name))) { out.write(bytes); }
        return name;
    }

    @PluginMethod
    public void share(PluginCall call) {
        JSArray names = call.getArray("names");
        File shareDir = new File(getContext().getCacheDir(), "exports");
        ArrayList<Uri> uris = new ArrayList<>();
        String type = "text/csv";
        try {
            for (int i = 0; names != null && i < names.length(); i++) {
                File f = new File(shareDir, clean(names.getString(i)));
                if (!f.exists()) continue;
                uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f));
                if (f.getName().endsWith(".xlsx")) type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            }
        } catch (Exception e) { /* skip */ }
        if (uris.isEmpty()) { call.reject("Nothing to share"); return; }
        Intent send = new Intent(uris.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
        send.setType(uris.size() > 1 ? "*/*" : type);
        if (uris.size() > 1) send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        else send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, "Share export");
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(chooser);
        call.resolve();
    }

    private static String clean(String n) {
        String s = n == null ? "" : n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", " ").trim();
        return s.isEmpty() ? "Export.csv" : s;
    }
}
