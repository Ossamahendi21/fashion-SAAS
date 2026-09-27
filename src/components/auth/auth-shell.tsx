import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { routes } from "@/lib/routes";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <a href="#auth-form" className="auth-skip-link">
        Skip to account form
      </a>
      <header className="auth-nav">
        <Link href={routes.home} className="auth-wordmark" aria-label="Fitcheck home">
          <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <path d="M9 2H2v7M19 2h7v7M26 19v7h-7M9 26H2v-7" stroke="currentColor" strokeWidth="2" />
            <path d="m8 14 4 4 8-9" stroke="currentColor" strokeWidth="2.5" />
          </svg>
          <span>fitcheck.</span>
        </Link>
        <div className="auth-nav-actions">
          <Link href={routes.home} className="auth-back-link">
            <ArrowLeft size={14} aria-hidden="true" /> Back to the site
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="auth-main">
        <section className="auth-form-panel" aria-label="Your Fitcheck account">
          <div id="auth-form" className="auth-form-content" tabIndex={-1}>
            {children}
          </div>
        </section>
        <aside className="auth-editorial" aria-labelledby="auth-editorial-title">
          <div className="auth-editorial-heading">
            <p className="auth-eyebrow">The everyday, reimagined</p>
            <h2 id="auth-editorial-title">
              A fresh look.
              <br />
              <span>Already yours.</span>
            </h2>
          </div>
          <div className="auth-look-study">
            <figure className="auth-look auth-look-main">
              <Image
                src="/landing/editorial-man.webp"
                alt="Sand jacket, white tee and blue jeans styled as an everyday outfit"
                width={1000}
                height={1500}
                sizes="(min-width: 1024px) 30vw, 1px"
                loading="eager"
              />
              <figcaption>Everyday, elevated.</figcaption>
            </figure>
            <figure className="auth-look auth-look-detail">
              <Image
                src="/landing/editorial-woman.webp"
                alt="Black leather jacket styled with a white top and straight-leg jeans"
                width={1000}
                height={1500}
                sizes="(min-width: 1024px) 17vw, 1px"
              />
              <figcaption>A different perspective.</figcaption>
            </figure>
            <div className="auth-garment" aria-hidden="true">
              <ArrowUpRight size={16} />
              <Image src="/demo-wardrobe/mens-cotton-jacket.png" alt="" width={180} height={180} sizes="120px" />
              <span>One piece. New possibilities.</span>
            </div>
          </div>
          <div className="auth-editorial-footer">
            <p>Rediscover the clothes you already own.</p>
            <span>Illustrative styling</span>
          </div>
        </aside>
      </main>
    </div>
  );
}
