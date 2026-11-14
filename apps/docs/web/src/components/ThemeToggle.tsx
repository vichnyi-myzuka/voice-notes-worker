import { useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setDark(next);
  };
  return (
    <button onClick={toggle} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" aria-label="Змінити тему">
      {dark ? "☀️ Світла" : "🌙 Темна"}
    </button>
  );
}
