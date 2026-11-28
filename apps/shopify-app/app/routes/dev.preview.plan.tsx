import { plan } from "../dev/preview-data";
import Screen from "./app.plan";

// Development-only preview of the plan screen with sample data (see dev.preview.tsx).
export const loader = async () => {
  if (process.env.NODE_ENV === "production")
    throw new Response("Not found", { status: 404 });
  return plan;
};

export default Screen;
