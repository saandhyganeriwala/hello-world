import QRCode from "qrcode";
import type { ConnectInfo } from "../components/ConnectWhatsApp";
import { connectLinks, getOrCreateLinkCode } from "./whatsapp.server";

/** Everything the ConnectWhatsApp component needs: code, wa.me link and a QR code SVG. */
export async function buildConnectInfo(shopId: string): Promise<ConnectInfo> {
  const link = await getOrCreateLinkCode(shopId);
  const links = connectLinks(link.code);
  const qrSvg = links.url
    ? await QRCode.toString(links.url, {
        type: "svg",
        margin: 0,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      })
    : null;
  return {
    code: link.code,
    url: links.url,
    text: links.text,
    displayNumber: links.displayNumber,
    qrSvg,
    expiresAt: link.expiresAt.toISOString(),
  };
}
