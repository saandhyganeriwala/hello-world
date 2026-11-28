import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";

export interface ConnectInfo {
  code: string;
  url: string | null;
  text: string;
  displayNumber: string;
  qrSvg: string | null;
  expiresAt: string;
}

interface Props {
  connect: ConnectInfo;
  /** Number of linked numbers when the page loaded; the component polls until it changes. */
  linkedCount: number;
  allowSimulate: boolean;
}

/**
 * Shows the one-tap WhatsApp link (and a QR code for desktop) and waits for the merchant's message.
 * Polls a lightweight status route every 4 s while the tab is visible, for up to 10 minutes.
 */
export function ConnectWhatsApp({
  connect,
  linkedCount,
  allowSimulate,
}: Props) {
  const status = useFetcher<{ linkedCount: number }>();
  const simulate = useFetcher();
  const revalidator = useRevalidator();
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    startedAt.current = Date.now();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - (startedAt.current ?? 0) > 10 * 60 * 1000)
        return window.clearInterval(id);
      if (status.state === "idle") status.load("/app/status");
    }, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      status.data &&
      status.data.linkedCount !== linkedCount &&
      revalidator.state === "idle"
    ) {
      revalidator.revalidate();
    }
  }, [status.data, linkedCount, revalidator]);

  return (
    <s-stack direction="inline" gap="large" alignItems="start">
      <s-stack direction="block" gap="base" maxInlineSize="360px">
        <s-paragraph>
          Tap the button to open WhatsApp with your connection message already
          typed, then press send. On a computer, scan the code with your phone
          instead.
        </s-paragraph>

        {connect.url ? (
          <s-stack direction="inline" gap="small-200">
            <s-button
              variant="primary"
              href={connect.url}
              target="_blank"
              icon="chat"
            >
              Open WhatsApp
            </s-button>
            {allowSimulate && (
              <s-button
                variant="tertiary"
                onClick={() =>
                  simulate.submit(
                    { intent: "simulate-link", code: connect.code },
                    { method: "POST" },
                  )
                }
                {...(simulate.state !== "idle" ? { loading: true } : {})}
              >
                Simulate (development only)
              </s-button>
            )}
          </s-stack>
        ) : (
          <s-banner tone="warning" heading="WhatsApp number not configured">
            Set WHATSAPP_DISPLAY_NUMBER on the server to show the connect
            button.
            {allowSimulate && (
              <s-box paddingBlockStart="small-200">
                <s-button
                  onClick={() =>
                    simulate.submit(
                      { intent: "simulate-link", code: connect.code },
                      { method: "POST" },
                    )
                  }
                  {...(simulate.state !== "idle" ? { loading: true } : {})}
                >
                  Simulate connection (development only)
                </s-button>
              </s-box>
            )}
          </s-banner>
        )}

        <s-grid
          gridTemplateColumns="auto 1fr"
          gap="small-200"
          alignItems="center"
        >
          <s-spinner
            size="base"
            accessibilityLabel="Waiting for your message"
          />
          <s-text color="subdued">
            Waiting for your message. This page updates by itself.
          </s-text>
        </s-grid>

        <s-text color="subdued">
          {connect.displayNumber
            ? `Or send "LINK-${connect.code}" to ${connect.displayNumber}. `
            : ""}
          The code works for 10 minutes and only once.
        </s-text>
      </s-stack>

      {connect.qrSvg && (
        <s-box
          border="base"
          borderRadius="base"
          padding="small-200"
          inlineSize="168px"
          blockSize="168px"
        >
          {/* SVG generated on our server from our own wa.me URL; safe to inline. */}
          <div
            role="img"
            aria-label="QR code that opens WhatsApp with your connection message"
            style={{ width: "100%", height: "100%" }}
            dangerouslySetInnerHTML={{ __html: connect.qrSvg }}
          />
        </s-box>
      )}
    </s-stack>
  );
}
