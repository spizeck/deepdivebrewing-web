// Real brewery photography for the editorial photo surfaces: the
// "Inside Deep Dive" section on /about and the homepage teaser
// (Issue #193). Every asset is genuine brewhouse photography from
// public/photos — never stock imagery.
//
// `gallery-*.jpg` files are 2048px-long-edge derivatives produced by
// scripts/optimize-assets.mjs; the multi-megabyte PXL_* phone originals
// stay in the repo as sources of truth and are never served to a page.
// herobrewhouse.jpg, herograin.jpg, and video-still.jpg predate this set
// and are already served at their committed sizes.

export interface BreweryPhoto {
  id: string;
  /** Served derivative under /photos. */
  src: string;
  width: number;
  height: number;
  /** Concise description for assistive tech — the photo's content. */
  alt: string;
  /**
   * Short visible caption. Only facts already established in the site's
   * copy or plainly visible in the image — no invented history, specs,
   * or process claims. The /about smoke test forbids em dashes in the
   * article, so captions must not contain one.
   */
  caption: string;
}

export const BREWERY_PHOTOS: readonly BreweryPhoto[] = [
  {
    id: "brewhouse-row",
    src: "/photos/herobrewhouse.jpg",
    width: 1920,
    height: 1080,
    alt: "A row of stainless steel Alpha brewing tanks with hard-piped lines and hoses overhead.",
    caption: "Inside the 26-by-26-foot brewery at Fort Bay.",
  },
  {
    id: "alpha-vessel",
    src: "/photos/gallery-alpha-vessel.jpg",
    width: 1152,
    height: 2048,
    alt: "A stainless brewhouse vessel with the Alpha Brewing Operations badge above a grain-filled sight glass.",
    caption: "The brewhouse from Alpha Brewing Operations in Nebraska.",
  },
  {
    id: "mash-tun",
    src: "/photos/gallery-mash-tun.jpg",
    width: 2048,
    height: 1152,
    alt: "The mash tun door with milled grain visible through a small round sight glass.",
    caption: "Grain in the mash tun; spent grain is collected for reuse around the island.",
  },
  {
    id: "valve-manifold",
    src: "/photos/gallery-valve-manifold.jpg",
    width: 2048,
    height: 1152,
    alt: "Stainless pipework and green-handled valves routing between the brewhouse vessels.",
    caption: "The valve manifold on the brewhouse.",
  },
  {
    id: "pipework",
    src: "/photos/gallery-pipework.jpg",
    width: 2048,
    height: 1152,
    alt: "Hard-piped stainless lines and labeled green valve handles beneath the brewhouse tanks.",
    caption: "Hard-piped beneath the tanks.",
  },
  {
    id: "grain",
    src: "/photos/herograin.jpg",
    width: 1920,
    height: 1080,
    alt: "Malted barley draining into the mash in a swirling cone of grain.",
    caption: "Malted barley, the start of every batch.",
  },
  {
    id: "wort",
    src: "/photos/video-still.jpg",
    width: 1280,
    height: 720,
    alt: "Amber wort flowing through a stainless sight glass tube on the brewhouse.",
    caption: "Wort running through the sight glass.",
  },
];
