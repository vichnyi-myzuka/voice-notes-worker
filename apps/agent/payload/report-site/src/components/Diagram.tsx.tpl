import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { series } from "./ChartCard";

// Схеми зібрані з SVG і кольорів-токенів, як і графіки: жодних hex

const MIN = 0.3;
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

function Svg({ title, viewBox, children, className }: { title: string; viewBox: string; children: ReactNode; className?: string }) {
  return (
    <svg viewBox={viewBox} className={className} role="img" aria-label={title} fontFamily="inherit">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--muted-foreground)" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

// Повноекранний перегляд: колесо й щипок масштабують, перетягування рухає, Esc закриває
function Viewer({ title, viewBox, children, onClose }: { title: string; viewBox: string; children: ReactNode; onClose: () => void }) {
  const area = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;

  // Масштаб навколо точки (px, py) відносно області перегляду
  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const s = clamp(v.s * factor);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  const center = () => {
    const r = area.current!.getBoundingClientRect();
    return [r.width / 2, r.height / 2] as const;
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // wheel має бути не пасивним, щоб скасувати прокрутку сторінки
    const el = area.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", key);
      el.removeEventListener("wheel", wheel);
      document.body.style.overflow = prev;
    };
  }, []);

  const down = (e: React.PointerEvent) => {
    area.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = 0;
  };
  const move = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const prev = { ...p };
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.current.size === 1) {
      setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current) {
        const r = area.current!.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, dist / pinch.current);
      }
      pinch.current = dist;
    }
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pinch.current = 0;
  };

  const btn = "h-9 min-w-9 rounded-md border bg-card px-3 text-sm hover:bg-muted";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-label={title}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          <button className={btn} onClick={() => zoomAt(...center(), 1 / 1.3)} aria-label="Зменшити">−</button>
          <span className="w-12 text-center text-sm tabular-nums text-muted-foreground">{Math.round(view.s * 100)}%</span>
          <button className={btn} onClick={() => zoomAt(...center(), 1.3)} aria-label="Збільшити">+</button>
          <button className={btn} onClick={() => setView({ x: 0, y: 0, s: 1 })}>Скинути</button>
          <button className={btn} onClick={onClose}>Закрити</button>
        </div>
      </div>
      <div
        ref={area}
        className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        style={{ touchAction: "none" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={(e) => {
          const r = area.current!.getBoundingClientRect();
          zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8);
        }}
      >
        <div className="flex h-full w-full items-center justify-center p-4" style={{ transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <Svg title={title} viewBox={viewBox} className="max-h-full w-full select-none">{children}</Svg>
        </div>
      </div>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">Колесо чи щипок — масштаб, перетягування — рух, подвійний клік — наблизити, Esc — закрити</p>
    </div>
  );
}

export function DiagramCard({ title, description, viewBox, children, className }: { title: string; description?: string; viewBox: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          <button className="shrink-0 rounded-md border bg-card px-3 py-1.5 text-xs hover:bg-muted" onClick={() => setOpen(true)}>⤢ На весь екран</button>
        </div>
      </CardHeader>
      <CardContent>
        <Svg title={title} viewBox={viewBox} className="h-auto w-full">{children}</Svg>
      </CardContent>
      {open && <Viewer title={title} viewBox={viewBox} onClose={() => setOpen(false)}>{children}</Viewer>}
    </Card>
  );
}

type BoxProps = { x: number; y: number; w: number; h: number; title: string; lines?: string[]; color?: number; dashed?: boolean };

// Блок: кольорова смужка зліва, заголовок і короткі рядки
export function Box({ x, y, w, h, title, lines = [], color = 0, dashed }: BoxProps) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill="var(--card)" stroke="var(--border)" strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} />
      <rect x={x} y={y} width={5} height={h} rx={2} fill={series(color)} />
      <text x={x + 16} y={y + 24} fill="var(--foreground)" fontSize={14} fontWeight={600}>{title}</text>
      {lines.map((l, i) => (
        <text key={i} x={x + 16} y={y + 46 + i * 18} fill="var(--muted-foreground)" fontSize={12}>{l}</text>
      ))}
    </g>
  );
}

// Стрілка (ламана); label стоїть біля середини першого сегмента
export function Arrow({ points, label, labelAt, dashed, both }: { points: [number, number][]; label?: string; labelAt?: [number, number]; dashed?: boolean; both?: boolean }) {
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  const [lx, ly] = labelAt ?? [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2 - 6];
  return (
    <g>
      <path d={d} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} markerEnd="url(#arrow)" markerStart={both ? "url(#arrow)" : undefined} />
      {label && <text x={lx} y={ly} textAnchor="middle" fill="var(--muted-foreground)" fontSize={11}>{label}</text>}
    </g>
  );
}
