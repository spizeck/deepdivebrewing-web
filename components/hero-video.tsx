"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Image from "next/image";

const POSTER_SRC = "/photos/herograin.jpg";
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
  const [canPlay, setCanPlay] = useState(false);
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
    video.preload = "metadata";
    void video.play().catch(() => {
      // Autoplay may be blocked by browser policy; the poster remains visible.
    });
  }, [inView, reducedMotion, isSmallScreen]);

  const showStaticPoster = reducedMotion || isSmallScreen;

  return (
    <section
      ref={sectionRef}
      className="animate-fade-in animate-delay-2 relative h-screen w-full overflow-hidden"
    >
      {showStaticPoster ? (
        <Image
          src={POSTER_SRC}
          alt="Brewery still image"
          fill
          priority={false}
          quality={70}
          sizes="100vw"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          loop
          playsInline
          preload="none"
          poster={POSTER_SRC}
          aria-label="Brewery process video"
          onCanPlay={() => setCanPlay(true)}
        >
          <source src={WEBM_SRC} type="video/webm" />
          <source src={MP4_SRC} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      )}

      {/* Fade-in overlay used only when the video is ready to avoid flash. */}
      {!showStaticPoster && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 bg-ink/60 transition-opacity duration-700 ${
            canPlay ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {(showStaticPoster || !canPlay) && (
        <div aria-hidden="true" className="absolute inset-0 bg-ink/60" />
      )}

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
