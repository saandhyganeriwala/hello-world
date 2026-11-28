import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

export interface GroupInfo {
  status: "creating" | "active" | "failed";
  subject: string;
  inviteLink: string | null;
  qrSvg: string | null;
  error: string | null;
  max: number;
  participants: { id: string; label: string; joinedAt: string }[];
}

interface Props {
  group: GroupInfo | null;
  /** Show member management (remove, reset link, delete). Home shows the compact version. */
  manage?: boolean;
  disabledReason?: string | null;
}

/** Create the store team WhatsApp group and invite people with its link (Meta's Groups API). */
export function TeamGroup({ group, manage = false, disabledReason }: Props) {
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  // While Meta finishes creating the group, poll for the invite link.
  useEffect(() => {
    if (group?.status !== "creating") return;
    const id = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      )
        revalidator.revalidate();
    }, 3000);
    return () => window.clearInterval(id);
  }, [group?.status, revalidator]);

  const submit = (intent: string, extra: Record<string, string> = {}) =>
    fetcher.submit({ intent, ...extra }, { method: "POST" });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      shopify.toast.show("Invite link copied");
    } catch {
      shopify.toast.show("Couldn't copy. Select the link instead.", {
        isError: true,
      });
    }
  };

  if (disabledReason) {
    return <s-paragraph color="subdued">{disabledReason}</s-paragraph>;
  }

  if (!group || group.status === "failed") {
    return (
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Storemate creates a WhatsApp group for your team. Anyone in it can ask
          Storemate to do things by mentioning “Storemate”. Up to 8 people,
          including you.
        </s-paragraph>
        {group?.status === "failed" && (
          <s-banner tone="critical" heading="The group couldn’t be created">
            <s-paragraph>
              Try again in a minute. If it keeps failing, contact support.
            </s-paragraph>
          </s-banner>
        )}
        <s-stack direction="inline">
          <s-button
            variant="primary"
            icon="chat-new"
            onClick={() => submit("create-group")}
            {...(busy ? { loading: true } : {})}
          >
            Create team group
          </s-button>
        </s-stack>
      </s-stack>
    );
  }

  if (group.status === "creating") {
    return (
      <s-grid
        gridTemplateColumns="auto 1fr"
        gap="small-200"
        alignItems="center"
      >
        <s-spinner accessibilityLabel="Creating group" />
        <s-text color="subdued">
          Creating “{group.subject}” on WhatsApp. This takes a few seconds.
        </s-text>
      </s-grid>
    );
  }

  const memberCount = group.participants.length;
  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="large" alignItems="start">
        <s-stack direction="block" gap="small-200" maxInlineSize="360px">
          <s-paragraph>
            <s-text type="strong">{group.subject}</s-text> is ready. Join it
            first, then share the link with your team. WhatsApp only lets people
            join by link.
          </s-paragraph>
          {group.inviteLink && (
            <s-box background="subdued" borderRadius="base" padding="small-200">
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-200"
                alignItems="center"
              >
                <s-text>{group.inviteLink}</s-text>
                <s-button
                  variant="tertiary"
                  icon="clipboard"
                  accessibilityLabel="Copy invite link"
                  onClick={() => copy(group.inviteLink!)}
                />
              </s-grid>
            </s-box>
          )}
          <s-stack direction="inline" gap="small-200">
            {group.inviteLink && (
              <s-button href={group.inviteLink} target="_blank" icon="chat">
                Join group
              </s-button>
            )}
            {group.inviteLink && (
              <s-button
                variant="tertiary"
                href={`https://wa.me/?text=${encodeURIComponent(`Join our store team group with Storemate: ${group.inviteLink}`)}`}
                target="_blank"
              >
                Share on WhatsApp
              </s-button>
            )}
          </s-stack>
          <s-text color="subdued">
            {memberCount} of {group.max - 1} spots used (Storemate takes one)
          </s-text>
        </s-stack>
        {group.qrSvg && (
          <s-box
            border="base"
            borderRadius="base"
            padding="small-200"
            inlineSize="148px"
            blockSize="148px"
          >
            <div
              role="img"
              aria-label="QR code to join the team group"
              style={{ width: "100%", height: "100%" }}
              dangerouslySetInnerHTML={{ __html: group.qrSvg }}
            />
          </s-box>
        )}
      </s-stack>

      {manage && (
        <s-stack direction="block" gap="small-200">
          {group.participants.length > 0 && (
            <s-stack direction="block" gap="small-200">
              {group.participants.map((p) => (
                <s-box
                  key={p.id}
                  border="base"
                  borderRadius="base"
                  padding="small-200"
                >
                  <s-stack
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-icon type="person" color="subdued" />
                      <s-text>{p.label}</s-text>
                    </s-stack>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      commandFor={`remove-member-${p.id}`}
                      command="--show"
                      {...(busy ? { disabled: true } : {})}
                    >
                      Remove
                    </s-button>
                  </s-stack>
                  <s-modal
                    id={`remove-member-${p.id}`}
                    heading={`Remove ${p.label}?`}
                  >
                    <s-paragraph>
                      They leave the group and can’t rejoin with the invite
                      link.
                    </s-paragraph>
                    <s-button
                      slot="primary-action"
                      variant="primary"
                      tone="critical"
                      commandFor={`remove-member-${p.id}`}
                      command="--hide"
                      onClick={() => submit("remove-participant", { id: p.id })}
                    >
                      Remove
                    </s-button>
                    <s-button
                      slot="secondary-actions"
                      commandFor={`remove-member-${p.id}`}
                      command="--hide"
                    >
                      Cancel
                    </s-button>
                  </s-modal>
                </s-box>
              ))}
            </s-stack>
          )}
          <s-stack direction="inline" gap="small-200">
            <s-button commandFor="reset-invite-modal" command="--show">
              New invite link
            </s-button>
            <s-button
              variant="tertiary"
              tone="critical"
              commandFor="delete-group-modal"
              command="--show"
            >
              Delete group
            </s-button>
          </s-stack>
          <s-modal id="reset-invite-modal" heading="Create a new invite link?">
            <s-paragraph>
              The current link stops working. People already in the group stay
              in it.
            </s-paragraph>
            <s-button
              slot="primary-action"
              variant="primary"
              commandFor="reset-invite-modal"
              command="--hide"
              onClick={() => submit("reset-invite")}
            >
              Create new link
            </s-button>
            <s-button
              slot="secondary-actions"
              commandFor="reset-invite-modal"
              command="--hide"
            >
              Cancel
            </s-button>
          </s-modal>
          <s-modal id="delete-group-modal" heading="Delete the team group?">
            <s-paragraph>
              Everyone is removed and no one can message the group again.
              One-to-one chats keep working.
            </s-paragraph>
            <s-button
              slot="primary-action"
              variant="primary"
              tone="critical"
              commandFor="delete-group-modal"
              command="--hide"
              onClick={() => submit("delete-group")}
            >
              Delete group
            </s-button>
            <s-button
              slot="secondary-actions"
              commandFor="delete-group-modal"
              command="--hide"
            >
              Cancel
            </s-button>
          </s-modal>
        </s-stack>
      )}
    </s-stack>
  );
}
