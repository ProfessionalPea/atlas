/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class', 
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        'headline-lg': ['Space Grotesk', 'sans-serif'], 
        'body-md': ['Inter', 'sans-serif'],
        'label-caps': ['Space Grotesk', 'sans-serif'],
        'metric-xl': ['Space Grotesk', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace'],
      },
      borderWidth: {
        'theme': 'var(--border-main)',
        'theme-thin': 'var(--border-thin)',
      },
      borderRadius: {
        'theme': 'var(--radius-main)',
        'theme-sm': 'var(--radius-sm)',
      },
      boxShadow: {
        'theme': 'var(--shadow-main)',
        'theme-hover': 'var(--shadow-hover)',
        'theme-sm': 'var(--shadow-sm)',
        'theme-sm-hover': 'var(--shadow-sm-hover)',
      },
      translate: {
        'theme-x': 'var(--translate-x)',
        'theme-y': 'var(--translate-y)',
      },
      colors: {
        "bg-base": "rgb(var(--bg-base) / <alpha-value>)",
        "surface-solid": "rgb(var(--surface-solid) / <alpha-value>)",
        "surface-glass": "rgb(var(--surface-glass) / <alpha-value>)",
        "input-bg": "rgb(var(--input-bg) / <alpha-value>)",
        "text-main": "rgb(var(--text-main) / <alpha-value>)",
        "text-muted": "rgb(var(--text-muted) / <alpha-value>)",
        "border-subtle": "rgb(var(--border-subtle) / <alpha-value>)",
        "electric-blue": "rgb(var(--electric-blue) / <alpha-value>)",
        "primary-container": "rgb(var(--primary-container) / <alpha-value>)",
        "on-primary-container": "rgb(var(--on-primary-container) / <alpha-value>)",
        "urgent-red": "rgb(var(--urgent-red) / <alpha-value>)",
        "emerald-metric": "rgb(var(--emerald-metric) / <alpha-value>)",
        "primary": "rgb(var(--primary) / <alpha-value>)",
        "secondary": "rgb(var(--secondary) / <alpha-value>)",
        "tertiary-container": "rgb(var(--tertiary-container) / <alpha-value>)",
      }
    }
  },
  plugins: [],
}