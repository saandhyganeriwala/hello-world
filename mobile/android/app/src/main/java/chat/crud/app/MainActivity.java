package chat.crud.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app (not in npm packages) must be registered before super.onCreate.
        registerPlugin(StorePlugin.class);
        registerPlugin(ShareInPlugin.class);
        registerPlugin(FilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
