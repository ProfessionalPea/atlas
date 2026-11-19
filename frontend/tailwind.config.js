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
        'sans': ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'headline-lg': ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'body-md': ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'label-caps': ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'metric-xl': ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
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
        "border-strong": "rgb(var(--border-strong) / <alpha-value>)",
        "electric-blue": "rgb(var(--electric-blue) / <alpha-value>)",
        "btn-primary": "rgb(var(--btn-primary) / <alpha-value>)",
        "btn-primary-hover": "rgb(var(--btn-primary-hover) / <alpha-value>)",
        "btn-primary-fg": "rgb(var(--btn-primary-fg) / <alpha-value>)",
        "accent": "rgb(var(--accent) / <alpha-value>)",
        "link": "rgb(var(--link) / <alpha-value>)",
        "primary-container": "rgb(var(--primary-container) / <alpha-value>)",
        "on-primary-container": "rgb(var(--on-primary-container) / <alpha-value>)",
        "urgent-red": "rgb(var(--sem-danger) / <alpha-value>)",
        "emerald-metric": "rgb(var(--sem-success) / <alpha-value>)",
        "sem-success": "rgb(var(--sem-success) / <alpha-value>)",
        "sem-warning": "rgb(var(--sem-warning) / <alpha-value>)",
        "sem-danger": "rgb(var(--sem-danger) / <alpha-value>)",
        "primary": "rgb(var(--accent) / <alpha-value>)",
        "secondary": "rgb(var(--sem-success) / <alpha-value>)",
        "tertiary-container": "rgb(var(--sem-warning) / <alpha-value>)",
      }
    }
  },
  plugins: [],
}
