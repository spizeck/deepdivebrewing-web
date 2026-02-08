import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Where to Buy | Deep Dive Brewing Co",
  description:
    "Find bars, restaurants, and retailers that carry Deep Dive Brewing Co beers.",
};

export default function WhereToBuyPage() {
  // TODO: Fetch venues from Firestore and render venue list
  return (
    <main className="mx-auto max-w-300 px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Where to Buy</h1>
      <p className="mt-2 text-muted-foreground">
        Coming soon — find our beers near you.
      </p>
    </main>
  );
}
