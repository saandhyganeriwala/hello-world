import { settingsGroup } from "../dev/preview-data";
import Screen from "./app.settings";

// Development-only preview of the settings screen with sample data (see dev.preview.tsx).
export const loader = async () => {
  if (process.env.NODE_ENV === "production")
    throw new Response("Not found", { status: 404 });
  return settingsGroup;
};

export default Screen;
