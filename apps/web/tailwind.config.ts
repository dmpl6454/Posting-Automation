import type { Config } from "tailwindcss";

/**
 * Build a full Tailwind colour scale (50…950) from ONE theme-aware HSL-triplet
 * CSS variable. See the `green`/`red`/`yellow` entries below for why.
 *
 * The low shades become alpha washes and everything from 300 up is the solid
 * colour, which matches how these classes are used in practice: 50/100 as an
 * alert background, 200 as its hairline border, 400–700 as the text/icon.
 *
 * `<alpha-value>` on the solid rungs keeps slash-opacity working, so an
 * existing `dark:bg-red-950/30` still resolves to a 30% wash.
 */
function statusScale(varName: string): Record<string, string> {
  const solid = `hsl(var(${varName}) / <alpha-value>)`;
  return {
    50: `hsl(var(${varName}) / 0.08)`,
    100: `hsl(var(${varName}) / 0.12)`,
    200: `hsl(var(${varName}) / 0.22)`,
    300: solid,
    400: solid,
    500: solid,
    600: solid,
    700: solid,
    800: solid,
    900: solid,
    950: solid,
    DEFAULT: solid,
  };
}

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
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
        /*
         * Surface ladder from the Claude Design restyle. These sit between
         * `background` and `card` and give the design its layered dark look.
         * Use with slash opacity, e.g. `bg-tile/60`, `border-border2`.
         */
        surface1: "hsl(var(--surface-1))",
        surface2: "hsl(var(--surface-2))",
        border2: "hsl(var(--border-2))",
        faint: "hsl(var(--faint))",
        tile: "hsl(var(--tile))",
        hover: "hsl(var(--hover))",
        gold: "hsl(var(--accent-gold))",

        /*
         * ── Semantic status scales, remapped onto the design palette ──
         *
         * The dashboard carries ~700 raw-Tailwind status classes across ~50
         * files (`bg-green-50 dark:bg-green-950/30`, `text-red-700`,
         * `border-yellow-200`, …). Stock Tailwind's saturated green/red/yellow
         * read as pasted onto a true-black + muted-gold palette, and that is
         * the single biggest remaining "the design isn't applied" signal.
         *
         * Rather than hand-edit 50 files (and re-break them on the next
         * feature), the FAMILIES are remapped onto the design's own status
         * tints, which live in globals.css as theme-aware HSL triplets:
         *
         *   50–200  → low-alpha wash  (how these shades are actually used:
         *                              alert backgrounds, hairline borders)
         *   300–950 → the solid tint  (how these are used: text, icons, fills)
         *
         * So `bg-green-50` becomes an 8% success wash and BOTH `text-green-700`
         * and `dark:text-green-400` become the solid success colour — each
         * correct in the theme it renders in, because the variable flips.
         *
         * ⚠️ Deliberately NOT remapped: blue / sky / indigo / cyan / purple /
         * pink / teal. Those carry PLATFORM BRAND identity in the post previews
         * (the Twitter tick and link blue, LinkedIn blue) and in the channel
         * icons — flattening them to gold would make a preview stop looking
         * like the platform it is previewing, which is worse than off-palette.
         */
        green: statusScale("--pa-success-hsl"),
        emerald: statusScale("--pa-success-hsl"),
        red: statusScale("--pa-danger-hsl"),
        rose: statusScale("--pa-danger-hsl"),
        yellow: statusScale("--pa-warning-hsl"),
        amber: statusScale("--pa-warning-hsl"),
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
      },
      /*
       * ⚠️ `var(--font-inter)` FIRST, and it is load-bearing.
       *
       * `app/layout.tsx` loads Inter through `next/font/google`, which
       * SELF-HOSTS the font under a generated family name (`__Inter_<hash>`)
       * and exposes it only as the CSS variable `--font-inter` on <html>.
       * This list used to start with the literal names "Inter var" / "Inter",
       * which match nothing unless Inter happens to be installed on the OS —
       * so on Windows every page fell through to **Segoe UI** while the design
       * is Inter throughout. That is a difference on every character of every
       * page, which is why the restyle kept reading as "not the design" even
       * with the palette correct.
       *
       * The literal names are kept after it as a belt-and-braces fallback for
       * a machine that does have Inter installed locally.
       */
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "Inter var",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        display: [
          "var(--font-inter)",
          "Inter var",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
      },
      boxShadow: {
        "glass": "0 8px 32px rgba(0, 0, 0, 0.06)",
        "glass-lg": "0 12px 48px rgba(0, 0, 0, 0.08)",
        "elevated": "0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.04)",
        "premium": "0 0 0 1px rgba(0, 0, 0, 0.03), 0 2px 4px rgba(0, 0, 0, 0.03), 0 12px 24px rgba(0, 0, 0, 0.06)",
      },
      animation: {
        "fade-in": "fadeIn 0.6s ease-out forwards",
        "fade-in-up": "fadeInUp 0.6s ease-out forwards",
        "shimmer": "shimmer 2s linear infinite",
        "float": "float 6s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        fadeInUp: {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
