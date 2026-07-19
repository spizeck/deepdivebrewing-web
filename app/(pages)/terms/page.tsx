import { MdxLayout } from "@/components/mdx-layout";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use | Deep Dive Brewing Co",
  description: "Terms governing the use of the Deep Dive Brewing Co. website.",
  alternates: {
    canonical: "/terms",
  },
  openGraph: {
    title: "Terms of Use | Deep Dive Brewing Co",
    description: "Terms governing the use of the Deep Dive Brewing Co. website.",
    url: "/terms",
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
    title: "Terms of Use | Deep Dive Brewing Co",
    description: "Terms governing the use of the Deep Dive Brewing Co. website.",
    images: ["/photos/og-default.jpg"],
  },
};

export default function TermsPage() {
  return (
    <MdxLayout>
      <h1>Terms of Use</h1>
      <p>
        By using this website, you agree to these terms. Please read them carefully. If you do not
        agree, please do not use the site.
      </p>

      <hr />

      <h2>Website Ownership</h2>
      <p>
        This website is owned and operated by Deep Dive Brews B.V., trading as Deep Dive Brewing Co.,
        a craft brewery based on Saba, Caribbean Netherlands.
      </p>

      <hr />

      <h2>Intellectual Property</h2>
      <p>
        All content on this website, including text, images, logos, branding, and design, is the
        property of Deep Dive Brews B.V. or used with permission. You may not copy, reproduce,
        redistribute, or modify these materials without our written consent.
      </p>

      <hr />

      <h2>Accuracy of Information</h2>
      <p>
        We do our best to keep the information on this website accurate and up to date, including
        details about our beers, availability, and where to buy them. However, we cannot guarantee
        that all information is complete, accurate, or current at all times.
      </p>

      <hr />

      <h2>Availability of Products</h2>
      <p>
        Beer availability varies by location, season, and distributor. Not all products are
        available in all places at all times. Check with the listed retailers or contact us directly
        to confirm what is currently available near you.
      </p>

      <hr />

      <h2>External Links</h2>
      <p>
        This website may contain links to third-party websites, including social media platforms and
        retail partners. We are not responsible for the content, accuracy, or privacy practices of
        those sites.
      </p>

      <hr />

      <h2>Responsible Use</h2>
      <p>
        You agree to use this website only for lawful purposes. Do not use it to harass others,
        distribute harmful content, attempt to compromise the site, or interfere with other users.
      </p>

      <hr />

      <h2>Limitation of Liability</h2>
      <p>
        This website is provided on an &quot;as is&quot; and &quot;as available&quot; basis. To the
        extent permitted by law, Deep Dive Brews B.V. is not liable for any damages arising from
        your use of, or inability to use, this website or the information it contains.
      </p>

      <hr />

      <h2>Governing Law</h2>
      <p>
        These Terms are governed by the laws applicable in the Caribbean Netherlands. Any disputes
        shall be resolved in the courts with jurisdiction over Saba, unless applicable law requires
        otherwise.
      </p>

      <hr />

      <h2>Responsible Drinking</h2>
      <p>
        Deep Dive Brewing Co. encourages the responsible enjoyment of our products. Please drink
        responsibly and only where legal.
      </p>

      <p className="text-sm text-muted-foreground">Last Updated: July 2026</p>
    </MdxLayout>
  );
}
