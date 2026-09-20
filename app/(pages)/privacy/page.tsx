import { MdxLayout } from "@/components/mdx-layout";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Learn how Deep Dive Brewing Co. collects, uses, and protects your information.",
  alternates: {
    canonical: "/privacy",
  },
  openGraph: {
    title: "Privacy Policy | Deep Dive Brewing Co",
    description:
      "Learn how Deep Dive Brewing Co. collects, uses, and protects your information.",
    url: "/privacy",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Privacy Policy | Deep Dive Brewing Co",
    description:
      "Learn how Deep Dive Brewing Co. collects, uses, and protects your information.",
    images: ["/photos/og-default.jpg"],
  },
};

export default function PrivacyPage() {
  return (
    <MdxLayout>
      <h1>Privacy Policy</h1>
      <p>
        The short version: we&rsquo;re a brewery, not a data company. We collect the information we
        need to run this website, answer people who contact us, and — if you allow it — understand
        how the site gets used. We don&rsquo;t sell your personal information, and we don&rsquo;t use
        advertising trackers.
      </p>
      <p>
        The longer version is below. We&rsquo;ve tried to write it like humans.
      </p>

      <hr />

      <h2>What we collect and why</h2>
      <p>
        We collect only the information we need to respond to you and improve the website. We do
        not sell personal information.
      </p>

      <h3>If you&rsquo;re interested in carrying our beer</h3>
      <p>
        When you submit the Trade &amp; Wholesale form, we collect your business name, contact
        name, email address, phone or WhatsApp number, venue or business type, and the details of
        your message. We use this information to respond to your inquiry, maintain a record of our
        business communications, and follow up where needed.
      </p>
      <p>
        Submitted inquiries are stored securely in our database (Google Cloud Firestore) and a
        notification copy is emailed to our team through Resend. We keep trade inquiries for up to
        24 months after our last meaningful interaction with you. We may delete them sooner when
        they are no longer needed, or keep them longer where reasonably necessary for legal,
        accounting, dispute-resolution, security, or other legitimate business purposes.
      </p>

      <h3>Getting in touch directly</h3>
      <p>
        If you email or WhatsApp us, we use the contact details you provide to respond and follow
        up on your request. That&rsquo;s it.
      </p>

      <h2>Cookies, the less delicious kind</h2>
      <p>
        We use one necessary cookie to remember your privacy choices, so the consent notice
        doesn&rsquo;t ask again on every visit. With your permission, Google Analytics sets a few
        more cookies to help us understand how the site is used.
      </p>
      <p>
        You can allow or decline analytics the first time you visit, and change your mind at any
        time using the &ldquo;Cookie preferences&rdquo; link in the site footer. Declining
        analytics doesn&rsquo;t stop the site from working.
      </p>

      <hr />

      <h2>Analytics, if you&rsquo;re okay with it</h2>
      <p>
        If you allow analytics, we use Google Analytics 4 — delivered through Google Tag Manager —
        to see things like which pages people visit and how they move through the site. The data
        we see is aggregated and pseudonymized; we&rsquo;re a small brewery trying to make a better
        website, and we don&rsquo;t use analytics to personally identify visitors.
      </p>
      <p>
        Google Analytics runs under Google Consent Mode: analytics cookies are stored and read
        only when you allow analytics. If you decline, no analytics cookies are stored.
      </p>
      <p>
        We also use Vercel Analytics from our hosting provider. It&rsquo;s cookieless and collects
        only aggregate traffic and page-speed data.
      </p>

      <hr />

      <h2>The third parties that keep this site running</h2>
      <p>
        These services handle some data as part of operating the website. Each has its own privacy
        policy and handles data according to its own terms.
      </p>

      <h3>Firebase / Google Cloud</h3>
      <p>
        Our website content and submitted trade inquiries are stored using Firebase and Google
        Cloud services. Access to stored inquiries is restricted to authorized staff.
      </p>

      <h3>Resend</h3>
      <p>
        Trade inquiry submissions are delivered to our team as notification emails through Resend,
        which processes the submitted details solely to deliver those messages.
      </p>

      <h3>Klaro (our consent manager)</h3>
      <p>
        We use Klaro, an open-source consent manager that runs in your browser as part of
        this website, to record your cookie and analytics consent choices. Your decision is
        stored in a cookie on your device — it is not sent to a separate consent service.
      </p>

      <h3>Google Maps</h3>
      <p>
        The contact page offers an optional Google Map showing where to find us. The map is not
        loaded until you choose &ldquo;Load map&rdquo; — visiting the page alone sends nothing to
        Google Maps. When you do load it, your browser connects to Google, which handles that
        request under its own privacy policy. The same applies to the &ldquo;Get directions&rdquo;
        link: it opens Google Maps in a new tab, and once you leave our site Google&rsquo;s own
        privacy practices apply.
      </p>

      <h3>Sentry</h3>
      <p>
        When something goes wrong on our servers, we send a technical error report to Sentry so we
        can find and fix the problem. Reports are filtered before they leave our servers to remove
        personal information — they never include inquiry contents, account details, cookies, or
        request data, and they do not set cookies or track you.
      </p>

      <h3>Social media links</h3>
      <p>
        Links to our social media profiles (Facebook, Instagram, and Untappd) are provided for your
        convenience. Once you leave our site, those platforms are responsible for their own
        privacy practices.
      </p>

      <hr />

      <h2>Data Security</h2>
      <p>
        We follow reasonable security practices to protect your information. However, no method of
        transmission over the internet is completely secure, so we cannot guarantee absolute
        security.
      </p>

      <hr />

      <h2>Your Rights</h2>
      <p>
        Subject to applicable law, you may request access to, correction of, or deletion of the
        personal information we hold about you — including a stored trade inquiry. To make a
        request, please contact us using the information below.
      </p>

      <hr />

      <h2>Contact Information</h2>
      <p>
        <strong>Deep Dive Brews B.V.</strong>
        <br />
        Trading as Deep Dive Brewing Co.
      </p>
      <p>
        66 Fort Bay Road
        <br />
        The Bottom, Saba
        <br />
        Caribbean Netherlands
      </p>
      <p>
        Email: <a href="mailto:info@deepdivebrewing.com">info@deepdivebrewing.com</a>
        <br />
        WhatsApp: <a href="https://wa.me/5994163544">+599 416 3544</a>
      </p>

      <p className="text-sm text-muted-foreground">Last Updated: September 2026</p>
    </MdxLayout>
  );
}
