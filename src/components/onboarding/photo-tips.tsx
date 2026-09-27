import { PersonStanding, Shirt, Square, Sun } from "lucide-react";

const TIPS = [
  { icon: Square, title: "Plain background", body: "A blank wall keeps the focus on you." },
  { icon: Shirt, title: "Neutral clothes", body: "Fitted, simple layers so garments sit naturally." },
  { icon: Sun, title: "Even light", body: "Face a window. No harsh shadows or direct flash." },
  {
    icon: PersonStanding,
    title: "Head to toe",
    body: "Include your shoes. Stand straight with your arms relaxed at your sides.",
  },
] as const;

/** What makes a photo render well. Shown next to the avatar uploader during onboarding. */
export function PhotoTips() {
  return (
    <section className="space-y-5 lg:border-l lg:pl-10" aria-labelledby="fitting-photo-tips">
      <div className="space-y-2">
        <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">The photo guide</p>
        <h2 id="fitting-photo-tips" className="text-2xl font-semibold tracking-tight">
          A better starting point.
        </h2>
        <p className="text-sm text-muted-foreground">Four small details that help clothes sit naturally.</p>
      </div>
      <ul className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {TIPS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="space-y-2 border-t pt-3">
            <Icon className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
