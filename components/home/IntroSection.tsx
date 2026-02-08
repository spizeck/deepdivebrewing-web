"use client";

import { useEffect, useRef } from "react";

interface IntroSectionProps {
  children: React.ReactNode;
}

export default function IntroSection({ children }: IntroSectionProps) {
  const introRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check for reduced motion preference
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Immediately apply visible state for reduced motion
      if (introRef.current) {
        introRef.current.classList.add("fade-in-visible");
      }
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("fade-in-visible");
        }
      },
      { threshold: 0.1 }
    );

    const currentRef = introRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, []);

  return (
    <section ref={introRef} className="scroll-fade-in mx-auto max-w-300 px-6 py-20 md:py-30">
      {children}
    </section>
  );
}
