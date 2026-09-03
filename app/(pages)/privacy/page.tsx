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
        We take your privacy seriously. This page explains what information we collect when you
        visit our website, how we use it, and how we keep it safe.
      </p>

      <hr />

      <h2>Information We Collect</h2>
      <p>
        We collect only the information we need to respond to your inquiries and improve the
        website. We do not sell personal information.
      </p>

      <h3>Contact form submissions</h3>
      <p>
        When you use our contact form, we collect your name, email address, phone number, and the
        details of your message. This information is used solely to respond to you and follow up on
        your request.
      </p>

      <h3>Newsletter signups</h3>
      <p>
        We may offer a newsletter or email updates in the future. If you choose to sign up, we will
        collect your email address and use it only to send you the communications you requested. You
        can unsubscribe at any time.
      </p>

      <h3>Cookies</h3>
      <p>
        Our website uses cookies and similar technologies to support analytics and basic site
        functionality. You can disable cookies through your browser settings, although some parts of
        the website may not function as intended.
      </p>

      <hr />

      <h2>Analytics</h2>
      <p>
        We use analytics services, including Google Analytics and Vercel Analytics, to better
        understand how visitors use our website and to improve performance and usability. These
        services provide aggregated and pseudonymized information. We do not use analytics to
        personally identify visitors.
      </p>

      <hr />

      <h2>Third-Party Services</h2>
      <p>
        We use trusted third-party services to operate the website. Each service has its own privacy
        policy and handles data according to its own terms.
      </p>

      <h3>Google Maps</h3>
      <p>
        If we embed Google Maps to help you find our locations, Google may collect data in
        accordance with its own privacy policy. We only embed maps where they add real value to the
        page.
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
        personal information we hold about you. To make a request, please contact us using the
        information below.
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

      <p className="text-sm text-muted-foreground">Last Updated: July 2026</p>
    </MdxLayout>
  );
}
