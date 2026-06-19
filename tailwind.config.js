/**
 * @type {import('tailwindcss').Config}
 *
 * TODO F38 — Tailwind v4 migration deferred.
 * v4 requires moving from a JS config to CSS-native @theme blocks, reworking
 * the plugin system, and updating PostCSS. This is a multi-day effort that
 * touches every utility class reference. Planned for a dedicated sprint after
 * the current feature set stabilises. See docs/22-grand-roadmap.md §F38.
 */
import tailwindAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  // K4-Tw — widened from the LSAT-only glob (`./src/domains/lsat/**`) to the
  // whole `src/` tree so Tailwind utilities are generated for host-authored
  // class usage too (the reskins + the eventual unified shell rely on this).
  // Done EARLY + isolated — with S6 style-isolation + the LSAT `@layer base`
  // body rule still in place — so a config regression is caught alone, not
  // tangled with the cascade cutover (K4-12/K4-13).
  content: ["./src/**/*.{ts,tsx,js,jsx}", "./index.html"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        // Verdict signature accent ramp (UI only — never a data category).
        verdict: {
          300: "hsl(var(--verdict-300))",
          400: "hsl(var(--verdict-400))",
          500: "hsl(var(--verdict-500))",
          600: "hsl(var(--verdict-600))",
          700: "hsl(var(--verdict-700))",
        },
        // Graphite neutral ramp (docs/07 §1.4). The semantic tokens above are
        // already derived from these; exposed here for charts/borders that need
        // a specific step (text-graphite-500, border-graphite-200, …).
        graphite: {
          50: "hsl(var(--graphite-50))",
          100: "hsl(var(--graphite-100))",
          200: "hsl(var(--graphite-200))",
          300: "hsl(var(--graphite-300))",
          400: "hsl(var(--graphite-400))",
          500: "hsl(var(--graphite-500))",
          600: "hsl(var(--graphite-600))",
          700: "hsl(var(--graphite-700))",
          800: "hsl(var(--graphite-800))",
          900: "hsl(var(--graphite-900))",
          950: "hsl(var(--graphite-950))",
        },
        // Okabe–Ito type-color families (docs/07 §1.5).
        // Hex values live in CSS variables (see index.css :root / .dark) for
        // dark-mode accessibility; utility classes (bg-tcolor-*) use var().
        tcolor: {
          assumption: "var(--tcolor-assumption)",
          strengthenWeaken: "var(--tcolor-strengthen-weaken)",
          flawStructure: "var(--tcolor-flaw-structure)",
          inference: "var(--tcolor-inference)",
          principle: "var(--tcolor-principle)",
          parallel: "var(--tcolor-parallel)",
          paradox: "var(--tcolor-paradox)",
          rc: "var(--tcolor-rc)",
        },
      },
      fontFamily: {
        sans: [
          "Geist Variable",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "Geist Mono Variable",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
        serif: [
          "Newsreader Variable",
          "ui-serif",
          "Georgia",
          "serif",
        ],
      },
      fontSize: {
        // docs/07 §2.2 type scale (px / line-height)
        // Micro tiers for dense chrome: chip counts, axis ticks, legend keys.
        micro: ["9px", "12px"],
        "2xs": ["10px", "14px"],
        xs: ["12px", "16px"],
        sm: ["14px", "20px"],
        base: ["15px", "24px"],
        lg: ["17px", "26px"],
        xl: ["20px", "28px"],
        "2xl": ["24px", "32px"],
        "3xl": ["30px", "38px"],
        "4xl": ["38px", "44px"],
        stat: ["48px", "52px"],
        "stat-xl": ["64px", "64px"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        chip: "4px",
        card: "10px",
      },
      boxShadow: {
        e0: "var(--elevation-0)",
        e1: "var(--elevation-1)",
        e2: "var(--elevation-2)",
        e3: "var(--elevation-3)",
        e4: "var(--elevation-4)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        // R8 — the aurora's slow breathing drift behind hero numerals.
        "aurora-drift": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)", opacity: "1" },
          "50%": { transform: "translate3d(0, -3%, 0) scale(1.05)", opacity: "0.85" },
        },
        // R8 — SVG path/ring trace-in (paired with pathLength on the element).
        "draw-on": {
          from: { "stroke-dashoffset": "1" },
          to: { "stroke-dashoffset": "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shimmer: "shimmer 1.6s infinite",
        // single-sourced with lib/motion.ts easing.emphasized = [0.3,0,0,1]
        "fade-up": "fade-up 0.2s cubic-bezier(0.3, 0, 0, 1)",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "aurora-drift": "aurora-drift 16s ease-in-out infinite",
        "draw-on": "draw-on 0.9s cubic-bezier(0.3, 0, 0, 1) forwards",
      },
    },
  },
  plugins: [tailwindAnimate],
};
