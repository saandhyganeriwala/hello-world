import { homeNew, homeActive, activity, settings } from "../dev/preview-data";
import Screen from "./app._index";

// Development-only preview of the _index screen with sample data (see dev.preview.tsx).
export const loader = async () => {
  if (process.env.NODE_ENV === "production")
    throw new Response("Not found", { status: 404 });
  void [homeNew, homeActive, activity, settings];
  return homeNew;
};

export default Screen;
