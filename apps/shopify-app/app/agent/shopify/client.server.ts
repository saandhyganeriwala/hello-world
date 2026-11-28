export type Graphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface Bucket {
  available: number;
  restoreRate: number;
  updatedAt: number;
}
const buckets = new Map<string, Bucket>();

/**
 * Shopify Admin GraphQL client for background work (offline token), with cost-aware throttling:
 * it mirrors the shop's leaky bucket from `extensions.cost.throttleStatus` and waits when low.
 */
export class ShopClient {
  constructor(
    readonly shopDomain: string,
    private graphqlFn: Graphql,
  ) {}

  static async forShop(shopDomain: string) {
    if (
      process.env.FAKE_SHOPIFY_STORE === "1" &&
      process.env.NODE_ENV !== "production"
    ) {
      const { fakeStoreGraphql } = await import("../../dev/fake-store.server");
      return new ShopClient(shopDomain, fakeStoreGraphql());
    }
    const { unauthenticated } = await import("../../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    return new ShopClient(shopDomain, admin.graphql as Graphql);
  }

  get graphql(): Graphql {
    return this.graphqlFn;
  }

  async query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    estimatedCost = 50,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.waitForBudget(estimatedCost);
      const res = await this.graphqlFn(query, { variables });
      const json = (await res.json()) as {
        data?: T;
        errors?:
          { message: string; extensions?: { code?: string } }[] | unknown;
        extensions?: {
          cost?: {
            throttleStatus?: {
              currentlyAvailable: number;
              restoreRate: number;
            };
          };
        };
      };
      const throttle = json.extensions?.cost?.throttleStatus;
      if (throttle) {
        buckets.set(this.shopDomain, {
          available: throttle.currentlyAvailable,
          restoreRate: throttle.restoreRate,
          updatedAt: Date.now(),
        });
      }
      const errors = Array.isArray(json.errors)
        ? json.errors
        : json.errors
          ? [json.errors]
          : [];
      const throttled = errors.some(
        (e) =>
          (e as { extensions?: { code?: string } })?.extensions?.code ===
          "THROTTLED",
      );
      if (throttled) {
        await sleep(2 ** attempt * 1000 + Math.random() * 500);
        continue;
      }
      if (errors.length)
        throw new ShopifyError(
          errors
            .map((e) => (e as { message?: string }).message ?? String(e))
            .join("; "),
          errors,
        );
      return json.data as T;
    }
    throw new ShopifyError(
      "Shopify is busy right now (rate limited). Please try again in a minute.",
    );
  }

  /** Runs a mutation and throws on userErrors (any payload field named userErrors). */
  async mutate<T = Record<string, unknown>>(
    mutation: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const data = await this.query<Record<string, unknown>>(
      mutation,
      variables,
      10,
    );
    const userErrors = Object.values(data ?? {}).flatMap(
      (payload) =>
        (
          payload as {
            userErrors?: { message: string; field?: string[] }[];
          } | null
        )?.userErrors ?? [],
    );
    if (userErrors.length)
      throw new ShopifyError(
        userErrors.map((e) => e.message).join("; "),
        userErrors,
      );
    return data as T;
  }

  private async waitForBudget(cost: number) {
    const bucket = buckets.get(this.shopDomain);
    if (!bucket) return;
    const elapsed = (Date.now() - bucket.updatedAt) / 1000;
    const available = bucket.available + elapsed * bucket.restoreRate;
    if (available >= cost) return;
    await sleep(
      Math.min(10_000, ((cost - available) / bucket.restoreRate) * 1000),
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
