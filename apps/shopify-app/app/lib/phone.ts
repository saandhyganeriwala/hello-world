/**
 * Masks a WhatsApp id (E.164 digits without "+") for display, e.g. "919812345210" -> "+91 ••••• •5210".
 * Country code detection is approximate; it is display only.
 */
export function maskPhone(waId: string): string {
  const digits = waId.replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  // Most national numbers have 10 digits; whatever precedes them is treated as the country code.
  const ccLength = Math.min(3, Math.max(1, digits.length - 10));
  const cc = digits.slice(0, ccLength);
  const last4 = digits.slice(-4);
  return `+${cc} ••••• ${last4}`;
}
