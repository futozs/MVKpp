/**
 * MVK MobilON+ — megosztott Tailwind preset.
 *
 * A shadcn/ui-val kompatibilis névtér (background, card, primary, muted,
 * border, ring, radius…), kiegészítve a projekt saját szemantikus
 * jelzéseivel (live / late / early) és a teljes zöld skálával.
 *
 * Minden érték a theme/tokens.css változóira mutat — a téma cseréjéhez
 * ez a fájl nem módosul.
 *
 * A tailwindcss-animate plugint az egyes appok configja adja hozzá: a
 * preset a repo gyökerében él, onnan nem látja az app node_modules-át.
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',

        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        /* Szemantikus jelzések — a zöld jelentése: „ez az adat élő”. */
        live: 'hsl(var(--live))',
        late: 'hsl(var(--late))',
        early: 'hsl(var(--early))',
        ontime: 'hsl(var(--ontime))',

        /* Teljes zöld skála árnyalatokhoz. */
        signal: {
          50: 'hsl(var(--sg-50))',
          100: 'hsl(var(--sg-100))',
          200: 'hsl(var(--sg-200))',
          300: 'hsl(var(--sg-300))',
          400: 'hsl(var(--sg-400))',
          500: 'hsl(var(--sg-500))',
          600: 'hsl(var(--sg-600))',
          700: 'hsl(var(--sg-700))',
          800: 'hsl(var(--sg-800))',
          900: 'hsl(var(--sg-900))',
          950: 'hsl(var(--sg-950))',
        },
      },

      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },

      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        glow: 'var(--shadow-glow)',
      },

      transitionDuration: {
        fast: 'var(--dur-fast)',
        normal: 'var(--dur-normal)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },

      zIndex: {
        map: 'var(--z-map)',
        overlay: 'var(--z-overlay)',
        bar: 'var(--z-bar)',
        drawer: 'var(--z-drawer)',
        dialog: 'var(--z-dialog)',
      },

      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        /* Élő adat üteme — a felület egyetlen ambient mozgása. */
        'live-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.4', transform: 'scale(0.75)' },
        },
        /* Adatfrissítéskor végigfutó jel a fejléc alatt. */
        'tick-sweep': {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(420%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'live-pulse': 'live-pulse 2.2s var(--ease-out) infinite',
        'tick-sweep': 'tick-sweep 1.2s var(--ease-out) infinite',
      },
    },
  },
  plugins: [],
}
