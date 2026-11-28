import { homeNew, homeActive, activity, settings } from "../dev/preview-data";
import Screen from "./app.activity";

// Development-only preview of the activity screen with sample data (see dev.preview.tsx).
export const loader = async () => {
  if (process.env.NODE_ENV === "production") throw new Response("Not found", { status: 404 });
  void [homeNew, homeActive, activity, settings];
  return activity;
};

export default Screen;
