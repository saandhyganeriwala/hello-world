import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Run your Shopify store from WhatsApp</h1>
        <p className={styles.text}>
          Storemate adds products, updates prices and shipping, and sends weekly
          sales summaries, all from a WhatsApp chat.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Products from photos</strong>. Send photos and a price;
            Storemate cleans the images and writes the listing.
          </li>
          <li>
            <strong>You approve every big change</strong>. Publishing, prices,
            shipping and discounts wait for your OK.
          </li>
          <li>
            <strong>Weekly summaries</strong>. Sales, top products and abandoned
            checkouts, delivered to WhatsApp.
          </li>
        </ul>
      </div>
    </div>
  );
}
