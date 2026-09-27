"use client";

import { ArrowUpRight, Check, ScanLine, Sparkles } from "lucide-react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import Image from "next/image";
import { useRef, type ReactNode } from "react";
import "./story.css";

const CHAPTERS = [
  {
    number: "01",
    label: "Make space for your style",
    title: (
      <>
        Your clothes.
        <br />A new perspective.
      </>
    ),
    description:
      "A camera-roll photo. A favourite website find. Scan the whole look, then choose exactly which pieces belong in your wardrobe.",
    note: "Scanning is free. Only the pieces you choose are imported.",
    name: "Scan & choose",
  },
  {
    number: "02",
    label: "A little outfit chemistry",
    title: (
      <>
        Less “what if”.
        <br />
        More “that’s it”.
      </>
    ),
    description:
      "Tell your stylist where you’re going and the feeling you’re after. Find fresh combinations in the clothes you already own, or put the pieces together yourself.",
    note: "Your wardrobe. Your taste. A fresh pair of eyes.",
    name: "Find your mix",
  },
  {
    number: "03",
    label: "Meet your next favourite look",
    title: (
      <>
        See the look.
        <br />
        Make it yours.
      </>
    ),
    description:
      "Bring your own photo to the fitting room. Preview the full outfit on you, try another combination, and save the looks worth coming back to.",
    note: "An AI preview to inspire your outfit, not a guarantee of fit.",
    name: "Try it on",
  },
] as const;

export function HowItWorks() {
  const track = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: track, offset: ["start start", "end end"] });
  const firstOpacity = useTransform(scrollYProgress, [0, 0.25, 0.3, 1], [1, 1, 0, 0]);
  const secondOpacity = useTransform(scrollYProgress, [0, 0.3, 0.35, 0.61, 0.66, 1], [0, 0, 1, 1, 0, 0]);
  const thirdOpacity = useTransform(scrollYProgress, [0, 0.66, 0.71, 1], [0, 0, 1, 1]);
  const firstY = useTransform(scrollYProgress, [0, 0.25, 0.3, 1], [0, 0, -32, -32]);
  const secondY = useTransform(scrollYProgress, [0, 0.3, 0.35, 0.61, 0.66, 1], [32, 32, 0, 0, -32, -32]);
  const thirdY = useTransform(scrollYProgress, [0, 0.66, 0.71, 1], [32, 32, 0, 0]);

  return (
    <section id="how-it-works" aria-labelledby="story-heading" className="fit-story">
      <div className="landing-shell fit-story-intro">
        <p className="landing-kicker">A wardrobe with possibilities</p>
        <h2 id="story-heading" className="landing-display">
          It’s already in your wardrobe.
          <br className="hidden sm:block" /> Let’s find it.
        </h2>
        <span className="fit-story-intro-note">From camera roll to ready to go.</span>
      </div>

      <div ref={track} className="fit-story-track">
        <div className="landing-shell fit-story-stage">
          <div className="fit-story-chapters">
            <StoryChapter index={0} opacity={firstOpacity} y={firstY}>
              <ScanIllustration />
            </StoryChapter>
            <StoryChapter index={1} opacity={secondOpacity} y={secondY}>
              <StyleIllustration />
            </StoryChapter>
            <StoryChapter index={2} opacity={thirdOpacity} y={thirdY}>
              <TryOnIllustration />
            </StoryChapter>
          </div>
          <div className="fit-story-timeline" aria-hidden="true">
            <div className="fit-story-timeline-line">
              <motion.span style={{ scaleX: scrollYProgress }} />
            </div>
            {CHAPTERS.map((chapter) => (
              <span key={chapter.number}>
                <span>{chapter.number}</span> {chapter.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function StoryChapter({
  index,
  opacity,
  y,
  children,
}: {
  index: 0 | 1 | 2;
  opacity: MotionValue<number>;
  y: MotionValue<number>;
  children: ReactNode;
}) {
  const chapter = CHAPTERS[index];
  return (
    <motion.article className="fit-story-chapter" style={{ opacity, y }} aria-labelledby={`chapter-${chapter.number}`}>
      <div className="fit-story-copy">
        <p className="landing-kicker">
          <span>{chapter.number} /</span> {chapter.label}
        </p>
        <h3 id={`chapter-${chapter.number}`} className="landing-display">
          {chapter.title}
        </h3>
        <p className="fit-story-description">{chapter.description}</p>
        <p className="fit-story-note">
          <ArrowUpRight size={15} aria-hidden="true" />
          {chapter.note}
        </p>
      </div>
      <div className="fit-story-art" aria-hidden="true">
        {children}
      </div>
    </motion.article>
  );
}

function ScanIllustration() {
  return (
    <div className="fit-story-scan">
      <div className="fit-story-source-photo">
        <Image src="/landing/editorial-man.webp" alt="" fill sizes="(max-width: 899px) 65vw, 30vw" />
        <span className="fit-story-image-caption">Illustrative style preview</span>
        <div className="fit-story-detection">
          <span>01 / JACKET</span>
        </div>
      </div>
      <div className="fit-story-scan-label">
        <ScanLine size={15} /> A whole look. Just your pick.
      </div>
      <div className="fit-story-chosen-piece">
        <div className="fit-story-chosen-top">
          <span>YOUR SELECTION</span>
          <span className="fit-story-tick">
            <Check size={14} />
          </span>
        </div>
        <div className="fit-story-chosen-image">
          <Image src="/demo-wardrobe/mens-cotton-jacket.png" alt="" fill sizes="(max-width: 899px) 32vw, 17vw" />
        </div>
        <div className="fit-story-chosen-caption">
          <strong>The everyday jacket</strong>
          <span>Keep the piece. Leave the rest.</span>
        </div>
      </div>
    </div>
  );
}

function StyleIllustration() {
  return (
    <div className="fit-story-style">
      <div className="fit-story-brief">
        <span className="landing-kicker">The brief</span>
        <p>
          “Dinner at seven.
          <br />
          Relaxed, but put-together.”
        </p>
        <Sparkles size={18} />
      </div>
      <div className="fit-story-outfit-board">
        <span className="fit-story-board-caption">THE EVERYDAY EDIT / 03 PIECES</span>
        <div className="fit-story-board-jacket">
          <Image src="/demo-wardrobe/mens-cotton-jacket.png" alt="" fill sizes="(max-width: 899px) 35vw, 19vw" />
        </div>
        <div className="fit-story-board-jeans">
          <Image src="/demo-wardrobe/blue-jeans.png" alt="" fill sizes="(max-width: 899px) 24vw, 13vw" />
        </div>
        <div className="fit-story-board-shoes">
          <Image src="/demo-wardrobe/white-red-trainers.webp" alt="" fill sizes="(max-width: 899px) 27vw, 14vw" />
        </div>
        <span className="fit-story-board-footer">
          <span className="fit-story-dot" /> Made from your wardrobe
        </span>
      </div>
    </div>
  );
}

function TryOnIllustration() {
  return (
    <div className="fit-story-try-on">
      <div className="fit-story-look-photo">
        <Image src="/landing/editorial-man.webp" alt="" fill sizes="(max-width: 899px) 68vw, 32vw" />
        <span className="fit-story-image-caption">Illustrative style preview</span>
      </div>
      <div className="fit-story-look-label">
        <span className="landing-kicker">The possibility</span>
        <strong>
          A familiar wardrobe.
          <br />A whole new look.
        </strong>
      </div>
      <div className="fit-story-look-rail">
        <span>THE PIECES</span>
        {[
          "/demo-wardrobe/mens-cotton-jacket.png",
          "/demo-wardrobe/blue-jeans.png",
          "/demo-wardrobe/white-red-trainers.webp",
        ].map((src) => (
          <div key={src}>
            <Image src={src} alt="" fill sizes="(max-width: 899px) 14vw, 7vw" />
          </div>
        ))}
      </div>
    </div>
  );
}
