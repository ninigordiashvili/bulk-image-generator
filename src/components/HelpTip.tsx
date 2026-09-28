"use client";

import { useId, useRef, useState, type ReactNode } from "react";

export function HelpTip({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom, left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)) });
    setOpen(true);
  };
  return <span className="relative inline-flex align-middle" onMouseEnter={show} onMouseLeave={() => setOpen(false)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
    <button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
      onFocus={show} onClick={show}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-xs font-semibold text-muted hover:border-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">!</button>
    {open && <span id={id} role="tooltip" style={position} className="fixed z-[60] w-64 max-w-[80vw] rounded-lg border border-line bg-surface p-3 text-left text-xs font-normal leading-relaxed text-muted shadow-xl">{children}</span>}
  </span>;
}
