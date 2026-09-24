"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";

// Issue #135: the brewery still replaces the grain hero photo so the static
// experience looks intentional instead of duplicating the hero above it.
const POSTER_SRC = "/photos/video-still.jpg";
const WEBM_SRC = "/videos/ddbwebvid.webm";
const MP4_SRC = "/videos/ddbwebvid.mp4";

function subscribeToMediaQuery(query: string, callback: () => void): () => void {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => subscribeToMediaQuery(query, callback),
    () => window.matchMedia(query).matches,
    () => false
  );
}

export function HeroVideo() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isSmallScreen = useMediaQuery("(max-width: 768px)");
  const [playing, setPlaying] = useState(false);
  const [inView, setInView] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0 }
    );

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !inView || reducedMotion || isSmallScreen) return;

    // Load metadata first so the browser can decide codec, then play.
    // play() itself initiates the fetch — no explicit load() needed.
    video.preload = "metadata";
    void video.play().catch((err: unknown) => {
      // Autoplay may be refused by browser policy (e.g. low-power mode);
      // the still stays visible either way. Dev-only diagnostic keeps
      // expected rejections (NotAllowedError) distinguishable from real
      // decode/network failures without sending noise to monitoring.
      if (process.env.NODE_ENV !== "production") {
        console.info(
          "[HeroVideo] play() rejected — static still remains.",
          err instanceof DOMException ? err.name : err,
          video.error?.code
        );
      }
    });
  }, [inView, reducedMotion, isSmallScreen]);

  // Deliberate: small screens get only the still — a multi-megabyte
  // decorative autoplay video is not worth the data/battery cost on
  // phones, and the approved still is a complete design, not a fallback.
  const showStaticPoster = reducedMotion || isSmallScreen;

  return (
    <section
      ref={sectionRef}
      className="animate-fade-in animate-delay-2 relative h-screen w-full overflow-hidden"
    >
      {/* Optimized poster is always rendered underneath. The <video> element
          deliberately has no poster attribute: the SSR'd poster attribute would
          fetch the raw JPEG at HTML parse time (before hydration and before the
          viewport gating below), duplicating the optimized image download. */}
      <Image
        src={POSTER_SRC}
        alt=""
        fill
        priority={false}
        quality={70}
        sizes="100vw"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {!showStaticPoster && (
        <video
          ref={videoRef}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
            playing ? "opacity-100" : "opacity-0"
          }`}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          // `playing` — not `canplay`: a refused play() still reaches
          // canplay (the fetch proceeds), which would fade in a frozen
          // first frame. Fading in on actual playback keeps the approved
          // still up whenever the video is not genuinely playing.
          onPlaying={() => setPlaying(true)}
        >
          <source src={WEBM_SRC} type="video/webm" />
          {/* The error event on the last <source> means every candidate
              failed — the still remains; log only in development. */}
          <source
            src={MP4_SRC}
            type="video/mp4"
            onError={() => {
              if (process.env.NODE_ENV !== "production") {
                console.info(
                  "[HeroVideo] no playable source — static still remains."
                );
              }
            }}
          />
          Your browser does not support the video tag.
        </video>
      )}

      <div aria-hidden="true" className="absolute inset-0 bg-ink/60" />

      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
        <h2 className="text-4xl font-bold tracking-tight text-paper sm:text-5xl md:text-6xl">
          The Brewery
        </h2>
        <p className="mt-4 max-w-lg text-lg text-paper/80">
          Brewing is equal parts craft and control. We track our process
          carefully so every batch is clean, consistent, and true to style —
          whether it&apos;s a crisp lager or a seasonal release. Take a peek behind
          the scenes.
        </p>
        <div className="mt-8">
          <Link
            href="/about"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-paper/30 bg-transparent px-6 text-sm font-medium text-paper transition-colors hover:bg-paper/10 focus-visible:ring-2 focus-visible:ring-paper/50"
          >
            Learn More
          </Link>
        </div>
      </div>
    </section>
  );
}
