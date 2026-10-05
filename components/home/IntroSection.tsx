import { Reveal } from "@/components/reveal";

interface IntroSectionProps {
  children: React.ReactNode;
}

export default function IntroSection({ children }: IntroSectionProps) {
  return (
    <Reveal
      as="section"
      className="mx-auto max-w-300 px-6 py-20 md:py-30"
    >
      {children}
    </Reveal>
  );
}
