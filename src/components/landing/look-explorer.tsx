"use client";

import { ArrowUpRight, Check, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { routes } from "@/lib/routes";

const LOOKS = [
  {
    name: "Everyday ease",
    number: "01",
    image: "/landing/editorial-man.webp",
    description:
      "The jacket you reach for. The jeans that fit just right. Your next look starts with the things you already love.",
    pieces: [
      { name: "The favourite jacket", file: "mens-cotton-jacket.png" },
      { name: "The everyday denim", file: "blue-jeans.png" },
      { name: "The finishing touch", file: "white-red-trainers.webp" },
    ],
  },
  {
    name: "A little edge",
    number: "02",
    image: "/landing/editorial-woman.webp",
    description:
      "A different mood, a familiar wardrobe. Rediscover how a few good pieces can come together in a whole new way.",
    pieces: [
      { name: "The statement layer", file: "womens-leather-jacket.png" },
      { name: "The everyday denim", file: "blue-jeans.png" },
      { name: "The evening option", file: "black-heeled-sandals.webp" },
    ],
  },
] as const;

export function LookExplorer() {
  const [selected, setSelected] = useState(0);
  const look = LOOKS[selected] ?? LOOKS[0];
  return (
    <section id="looks" className="landing-looks landing-shell" aria-labelledby="landing-looks-title">
      <div className="landing-looks-heading">
        <p className="landing-kicker">A little outfit inspiration</p>
        <span className="landing-kicker">SAME WARDROBE. FRESH EYES.</span>
      </div>
      <div className="landing-looks-grid">
        <div className="landing-look-photo">
          {LOOKS.map((item, index) => (
            <Image
              key={item.number}
              src={item.image}
              alt={index === 0 ? "A casual sand jacket and denim outfit" : "A leather jacket and denim outfit"}
              width={1000}
              height={1500}
              sizes="(max-width: 700px) 90vw, 45vw"
              className={selected === index ? "is-selected" : ""}
              aria-hidden={selected !== index}
            />
          ))}
          <div className="landing-look-photo-caption">
            <span>THE STYLE STUDY / {look.number}</span>
            <span>ILLUSTRATIVE PREVIEW</span>
          </div>
        </div>
        <div className="landing-look-details">
          <h2 id="landing-looks-title" className="landing-display">
            Different days.
            <br />
            <span className="landing-outline-word">Still you.</span>
          </h2>
          <div className="landing-look-switch" role="group" aria-label="Explore a style">
            <button type="button" aria-pressed={selected === 0} onClick={() => setSelected(0)}>
              {selected === 0 ? <Check size={14} /> : <Plus size={14} />} Everyday ease
            </button>
            <button type="button" aria-pressed={selected === 1} onClick={() => setSelected(1)}>
              {selected === 1 ? <Check size={14} /> : <Plus size={14} />} A little edge
            </button>
          </div>
          <p className="landing-look-description" aria-live="polite">
            {look.description}
          </p>
          <div className="landing-look-pieces">
            {look.pieces.map((piece, index) => (
              <div key={piece.name} className="landing-look-piece">
                <span className="landing-kicker">0{index + 1}</span>
                <Image
                  src={`/demo-wardrobe/${piece.file}`}
                  alt={piece.name}
                  width={220}
                  height={220}
                  sizes="(max-width: 700px) 25vw, 150px"
                />
                <span>{piece.name}</span>
              </div>
            ))}
          </div>
          <p className="landing-look-smallprint">
            Style inspiration, using example pieces. Your wardrobe makes it yours.
          </p>
          <Link href={routes.signUp} className="landing-text-link">
            See what’s in your wardrobe <ArrowUpRight size={19} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
