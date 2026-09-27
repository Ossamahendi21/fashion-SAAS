"use client";

import { ArrowDown, ArrowUpRight, MoveUpRight } from "lucide-react";
import { motion, useScroll, useTransform } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { useRef } from "react";
import { routes } from "@/lib/routes";
import { PLANS } from "@convex/shared/credits";

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const portraitY = useTransform(scrollYProgress, [0, 1], [0, 125]);
  const secondY = useTransform(scrollYProgress, [0, 1], [0, -100]);
  const jacketY = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const shoeY = useTransform(scrollYProgress, [0, 1], [0, -75]);
  const tilt = useTransform(scrollYProgress, [0, 1], [-9, 4]);
  const copyY = useTransform(scrollYProgress, [0, 1], [0, 50]);

  return (
    <section ref={ref} className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-shell landing-hero-grid">
        <motion.div className="landing-hero-copy" style={{ y: copyY }}>
          <p className="landing-kicker">
            <span className="landing-status-dot" /> A new way to get dressed
          </p>
          <h1 id="landing-title" className="landing-display landing-hero-title">
            Great style.
            <br />
            <span className="landing-outline-word">Already</span>
            <br />
            yours.
          </h1>
          <p className="landing-hero-description">
            That next favourite outfit? It’s in your wardrobe. Find it with your personal AI stylist. Then see it on
            you.
          </p>
          <Link href={routes.signUp} className="landing-button">
            Find your next look <ArrowUpRight aria-hidden="true" />
          </Link>
          <p className="landing-hero-note">{PLANS.free.signupCredits} free credits. No card needed.</p>
        </motion.div>
        <div className="landing-hero-art" aria-label="A fresh perspective on everyday clothes">
          <div className="landing-orbit" aria-hidden="true" />
          <span className="landing-art-coordinate" aria-hidden="true">
            THE EVERYDAY / REIMAGINED
          </span>
          <motion.figure className="landing-portrait landing-portrait-main" style={{ y: portraitY }}>
            <Image
              src="/landing/editorial-man.webp"
              alt="A relaxed look with a sand jacket, white tee and blue jeans"
              width={1000}
              height={1500}
              sizes="(max-width: 640px) 65vw, (max-width: 1000px) 48vw, 360px"
              loading="eager"
              fetchPriority="high"
            />
            <figcaption>
              <span>LOOK 001</span>
              <span>EVERYDAY, ELEVATED.</span>
            </figcaption>
          </motion.figure>
          <motion.figure className="landing-portrait landing-portrait-secondary" style={{ y: secondY, rotate: tilt }}>
            <Image
              src="/landing/editorial-woman.webp"
              alt="A black leather jacket styled with a white tee and straight blue jeans"
              width={1000}
              height={1500}
              sizes="(max-width: 640px) 36vw, 215px"
              loading="eager"
            />
            <figcaption>YOUR KIND OF DIFFERENT.</figcaption>
          </motion.figure>
          <motion.div className="landing-floating-piece landing-floating-jacket" style={{ y: jacketY, rotate: 10 }}>
            <span className="landing-piece-index">
              01 <MoveUpRight size={13} aria-hidden="true" />
            </span>
            <Image
              src="/demo-wardrobe/mens-cotton-jacket.png"
              alt="Sand cotton jacket"
              width={300}
              height={300}
              sizes="180px"
            />
            <span className="landing-piece-caption">
              AN OLD FAVOURITE.
              <br />A NEW WAY TO WEAR IT.
            </span>
          </motion.div>
          <motion.div className="landing-floating-piece landing-floating-shoe" style={{ y: shoeY, rotate: -12 }}>
            <Image
              src="/demo-wardrobe/white-red-trainers.webp"
              alt="White trainers with red details"
              width={260}
              height={180}
              sizes="170px"
            />
            <span className="landing-piece-caption">GOOD FROM THE GROUND UP.</span>
          </motion.div>
          <p className="landing-art-caption">
            <span aria-hidden="true">✳</span> Your clothes.
            <br />A fresh point of view.
          </p>
        </div>
      </div>
      <div className="landing-shell landing-hero-foot">
        <a href="#how-it-works">
          Scroll into your wardrobe <ArrowDown size={15} aria-hidden="true" />
        </a>
        <span>Less outfit indecision. More you.</span>
      </div>
    </section>
  );
}
