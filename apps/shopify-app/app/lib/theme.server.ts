import { config } from "./config.server";
import { isEmbedEnabled } from "./theme-embed";

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

/** Reads the live theme's settings_data.json (read_themes) to see if our app embed is on. */
export async function storefrontEmbedEnabled(
  graphql: AdminGraphql,
): Promise<boolean | null> {
  try {
    const res = await graphql(`
      #graphql
      query MainThemeSettings {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }
    `);
    const json = (await res.json()) as {
      data?: {
        themes?: {
          nodes?: { files?: { nodes?: { body?: { content?: string } }[] } }[];
        };
      };
    };
    const content =
      json.data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
    return isEmbedEnabled(content, undefined, config.bannerExtensionUid);
  } catch (error) {
    console.warn("[theme] could not read settings_data.json", error);
    return null; // unknown: the UI offers "Check again"
  }
}
