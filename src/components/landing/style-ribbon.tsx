"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";

export function StyleRibbon() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const x = useTransform(scrollYProgress, [0, 1], [80, -280]);
  return (
    <div ref={ref} className="landing-ribbon" aria-label="Your clothes. Your combinations. Your way.">
      <motion.div style={{ x }} aria-hidden="true">
        YOUR CLOTHES <span>✳</span> YOUR COMBINATIONS <span>✳</span> YOUR WAY <span>✳</span> YOUR CLOTHES
      </motion.div>
    </div>
  );
}
